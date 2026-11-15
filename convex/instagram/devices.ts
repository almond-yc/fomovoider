import { v } from "convex/values";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "../_generated/server";
import { requireUserId } from "../lib/auth";
import { PAIRING_TTL_MS, RUN_BUDGET } from "./limits";

// The app's Login { kind: "device", pair() }: creates (or re-arms) the user's
// device and returns a one-time code the host agent redeems with
// agent.redeemPairing. The account is connected when the agent redeems it.
export const pair = mutation({
  args: { name: v.optional(v.string()), timezone: v.optional(v.string()) },
  returns: v.object({ code: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => armPairing(ctx, await requireUserId(ctx), args),
});

// Same as pair, for the CLI: npx convex run instagram/devices:pairForUser.
export const pairForUser = internalMutation({
  args: { userId: v.id("users"), name: v.optional(v.string()), timezone: v.optional(v.string()) },
  returns: v.object({ code: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { userId, ...args }) => armPairing(ctx, userId, args),
});

async function armPairing(
  ctx: MutationCtx,
  userId: Id<"users">,
  { name, timezone }: { name?: string; timezone?: string },
) {
  const code = String(Math.floor(100_000 + Math.random() * 900_000));
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  const existing = await ctx.db
    .query("instagram_devices")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();
  const fields = { pairingCode: code, pairingExpiresAt: expiresAt, pairingArmedBy: userId };
  if (existing) {
    await ctx.db.patch(existing._id, {
      ...fields,
      ...(name ? { name } : {}),
      ...(timezone ? { timezone } : {}),
    });
  } else {
    await ctx.db.insert("instagram_devices", {
      userId,
      name: name ?? "iPhone",
      timezone: timezone ?? "America/Los_Angeles",
      scheduleEnabled: true,
      ...fields,
    });
  }
  return { code, expiresAt };
}

// Unpairs the phone: the agent's token stops working, open runs are cancelled,
// and the Instagram account with its cached content is removed through
// accounts.disconnect.
export const disconnect = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const device = await ctx.db
      .query("instagram_devices")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();
    if (device) {
      for (const state of ["pending", "claimed"] as const) {
        const open = await ctx.db
          .query("instagram_runs")
          .withIndex("by_deviceId_and_state_and_scheduledFor", (q) =>
            q.eq("deviceId", device._id).eq("state", state),
          )
          .collect();
        for (const run of open) {
          await ctx.db.patch(run._id, { state: "skipped", finishedAt: Date.now(), error: "disconnected" });
        }
      }
      await ctx.db.patch(device._id, {
        tokenHash: undefined,
        accountId: undefined,
        pairingCode: undefined,
        pairingExpiresAt: undefined,
        pairingArmedBy: undefined,
      });
    }
    await ctx.runMutation(api.accounts.disconnect, { platform: "instagram" });
    return null;
  },
});

// Stub matching internal.accounts.connectDevice({ userId, platform, deviceId })
// from FOMO-24 (ALM-21), which is not on main yet: connects (or reconnects)
// the user's account with a device session, pending until verifyIdentity.
// Remove it and call internal.accounts.connectDevice once that lands.
export const connectDevice = internalMutation({
  args: { userId: v.id("users"), platform: v.string(), deviceId: v.string() },
  returns: v.id("connectedAccounts"),
  handler: async (ctx, { userId, platform, deviceId }) => {
    const session = { platform, kind: "device" as const, deviceId };
    const existing = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId).eq("platform", platform))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        session,
        sessionVersion: (existing.sessionVersion ?? 0) + 1,
        status: "pending",
        lastError: undefined,
      });
      return existing._id;
    }
    return await ctx.db.insert("connectedAccounts", {
      userId,
      platform,
      session,
      sessionVersion: 1,
      status: "pending",
    });
  },
});

// The app's "Run now" button.
export const runNow = mutation({
  args: {},
  returns: v.id("instagram_runs"),
  handler: async (ctx) => queueManualRun(ctx, await requireUserId(ctx)),
});

export const runNowForUser = internalMutation({
  args: { userId: v.id("users") },
  returns: v.id("instagram_runs"),
  handler: async (ctx, { userId }) => queueManualRun(ctx, userId),
});

async function queueManualRun(ctx: MutationCtx, userId: Id<"users">) {
  const device = await ctx.db
    .query("instagram_devices")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();
  if (!device?.accountId) throw new Error("No paired Instagram device");
  if (device.pausedUntil !== undefined && device.pausedUntil > Date.now()) {
    throw new Error(`Device paused until ${new Date(device.pausedUntil).toISOString()}`);
  }
  for (const state of ["pending", "claimed"] as const) {
    const open = await ctx.db
      .query("instagram_runs")
      .withIndex("by_deviceId_and_state_and_scheduledFor", (q) =>
        q.eq("deviceId", device._id).eq("state", state).lte("scheduledFor", Date.now()),
      )
      .first();
    if (open) return open._id;
  }
  return await ctx.db.insert("instagram_runs", {
    deviceId: device._id,
    trigger: "manual",
    scheduledFor: Date.now(),
    state: "pending",
    budget: RUN_BUDGET,
  });
}

// Device health for the app's connector settings.
export const status = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      name: v.string(),
      paired: v.boolean(),
      pausedUntil: v.optional(v.number()),
      pauseReason: v.optional(v.string()),
      lastSeenAt: v.optional(v.number()),
      lastRun: v.optional(
        v.object({
          state: v.string(),
          trigger: v.string(),
          scheduledFor: v.number(),
          finishedAt: v.optional(v.number()),
          posts: v.optional(v.number()),
          storyFrames: v.optional(v.number()),
        }),
      ),
    }),
  ),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const device = await ctx.db
      .query("instagram_devices")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();
    if (!device) return null;
    const runs = await Promise.all(
      (["done", "aborted", "failed"] as const).map((state) =>
        ctx.db
          .query("instagram_runs")
          .withIndex("by_deviceId_and_state_and_scheduledFor", (q) =>
            q.eq("deviceId", device._id).eq("state", state),
          )
          .order("desc")
          .first(),
      ),
    );
    const last = runs
      .filter((run) => run !== null)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
    return {
      name: device.name,
      paired: device.accountId !== undefined && device.tokenHash !== undefined,
      pausedUntil: device.pausedUntil,
      pauseReason: device.pauseReason,
      lastSeenAt: device.lastSeenAt,
      lastRun: last && {
        state: last.state,
        trigger: last.trigger,
        scheduledFor: last.scheduledFor,
        finishedAt: last.finishedAt,
        posts: last.stats?.posts,
        storyFrames: last.stats?.storyFrames,
      },
    };
  },
});
