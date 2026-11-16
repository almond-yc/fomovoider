import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requireUserId } from "../lib/auth";
import { vMedia, vPerson, vPostInput, type PostInput } from "../lib/validators";
import { finishClaimedRun, ownedAccount, ownUpload, upsertFacts } from "./agent";
import { closeOpenRuns, killSwitch } from "./common";
import {
  WEBVIEW_BUDGET,
  WEBVIEW_MAX_RUNS_PER_DAY,
  WEBVIEW_MIN_GAP_MS,
  WEBVIEW_STALE_CLAIM_MS,
} from "./limits";
import { vFacts, vFeedVariant, vRunStats, vTripwire } from "./schema";

// Public functions for the Fomovoider app's hidden instagram.com web view
// (src/instagram/). The app is signed in to Convex as the user, so these
// authenticate with the user's identity; Instagram's cookies stay in the web
// view on the phone and never reach Convex. The account's Session is
// { kind: "device", deviceId } pointing at the user's instagram_devices row
// with transport "webview".

async function userDevice(ctx: QueryCtx, userId: Id<"users">) {
  return await ctx.db
    .query("instagram_devices")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();
}

// Called once the user has logged in to instagram.com in the web view and the
// page has shown who they are (xdt_viewer). Connects the account on first use
// and confirms its identity; a different Instagram account than last time
// purges the old one's content (accounts.verifyIdentity).
export const connect = mutation({
  args: { me: vPerson, timezone: v.optional(v.string()) },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, { me, timezone }): Promise<{ status: string }> => {
    const userId = await requireUserId(ctx);
    if (me.platform !== "instagram") throw new Error("Not an Instagram identity");
    let device = await userDevice(ctx, userId);
    if (!device) {
      const id = await ctx.db.insert("instagram_devices", {
        userId,
        name: "Fomovoider app",
        timezone: timezone ?? "America/Los_Angeles",
        scheduleEnabled: true,
        transport: "webview",
      });
      device = (await ctx.db.get(id))!;
    } else {
      // Logging in again lifts a pause that a login page caused; challenge
      // and rate-limit pauses stay.
      const loginPause = device.pauseReason?.startsWith("login:") ?? false;
      // Switching from the Mac host agent revokes its token and ends its runs,
      // so only the web view reads from now on.
      if (device.transport !== "webview") await closeOpenRuns(ctx, device._id, "switched to the app web view");
      await ctx.db.patch(device._id, {
        transport: "webview",
        tokenHash: undefined,
        ...(timezone ? { timezone } : {}),
        ...(loginPause ? { pausedUntil: undefined, pauseReason: undefined } : {}),
      });
    }
    let accountId: Id<"connectedAccounts"> | undefined = device.accountId;
    const account = accountId ? await ctx.db.get(accountId) : null;
    const linked =
      account &&
      account.userId === userId &&
      account.session.kind === "device" &&
      account.session.deviceId === device._id;
    if (!linked) {
      accountId = await ctx.runMutation(internal.accounts.connectDevice, {
        userId,
        platform: "instagram",
        deviceId: device._id,
      });
    }
    await ctx.db.patch(device._id, { accountId, lastSeenAt: Date.now() });
    await ctx.runMutation(internal.accounts.verifyIdentity, { accountId: accountId!, me });
    return { status: (await ctx.db.get(accountId!))?.status ?? "missing" };
  },
});

const vCursor = v.object({
  endCursor: v.optional(v.string()),
  hasNextPage: v.boolean(),
  newestId: v.optional(v.string()),
  newestAt: v.optional(v.number()),
});

const vStart = v.union(
  v.object({
    kind: v.literal("blocked"),
    reason: v.union(v.literal("kill_switch"), v.literal("paused"), v.literal("not_connected")),
    until: v.optional(v.number()),
    detail: v.optional(v.string()),
  }),
  v.object({ kind: v.literal("wait"), reason: v.union(v.literal("busy"), v.literal("too_soon"), v.literal("daily_limit")), retryAt: v.number() }),
  v.object({
    kind: v.literal("run"),
    runId: v.id("instagram_runs"),
    trigger: v.string(),
    budget: v.object({ maxMs: v.number(), maxPosts: v.number(), maxStoryFrames: v.number() }),
    cursors: v.object({ home: v.optional(vCursor), following: v.optional(vCursor), stories: v.optional(vCursor) }),
    knownIds: v.array(v.string()),
  }),
);

// Asks Convex for permission and a budget before the web view reads anything.
// Refreshes are refused while the kill switch is on or the device is paused
// after a tripwire, and spaced by trigger (limits.ts). A pending "Run now"
// from devices.runNow is picked up here.
export const startRefresh = mutation({
  args: { trigger: v.union(v.literal("open"), v.literal("background"), v.literal("manual")) },
  returns: vStart,
  handler: async (ctx, { trigger }) => {
    const userId = await requireUserId(ctx);
    const device = await userDevice(ctx, userId);
    if (!device?.accountId || device.transport !== "webview") {
      return { kind: "blocked" as const, reason: "not_connected" as const };
    }
    const now = Date.now();
    const kill = await killSwitch(ctx);
    if (kill) return { kind: "blocked" as const, reason: "kill_switch" as const, detail: kill.reason };
    if (device.pausedUntil !== undefined && device.pausedUntil > now) {
      return { kind: "blocked" as const, reason: "paused" as const, until: device.pausedUntil, detail: device.pauseReason };
    }
    await ownedAccount(ctx, device);
    await ctx.db.patch(device._id, { lastSeenAt: now });

    const runs = (state: Doc<"instagram_runs">["state"], since = 0) =>
      ctx.db
        .query("instagram_runs")
        .withIndex("by_deviceId_and_state_and_scheduledFor", (q) =>
          q.eq("deviceId", device._id).eq("state", state).gte("scheduledFor", since),
        );
    for (const run of await runs("claimed").collect()) {
      if ((run.claimedAt ?? 0) >= now - WEBVIEW_STALE_CLAIM_MS) {
        return { kind: "wait" as const, reason: "busy" as const, retryAt: (run.claimedAt ?? now) + WEBVIEW_STALE_CLAIM_MS };
      }
      await ctx.db.patch(run._id, { state: "failed", finishedAt: now, error: "web view never finished" });
    }
    const dayAgo = now - 24 * 3_600_000;
    const recent: Doc<"instagram_runs">[] = [];
    for (const state of ["done", "aborted", "failed"] as const) recent.push(...(await runs(state, dayAgo).collect()));
    if (recent.length >= WEBVIEW_MAX_RUNS_PER_DAY) {
      const oldest = Math.min(...recent.map((r) => r.scheduledFor));
      return { kind: "wait" as const, reason: "daily_limit" as const, retryAt: oldest + 24 * 3_600_000 };
    }
    const pending = await ctx.db
      .query("instagram_runs")
      .withIndex("by_deviceId_and_state_and_scheduledFor", (q) =>
        q.eq("deviceId", device._id).eq("state", "pending").lte("scheduledFor", now),
      )
      .first();
    const effective = pending ? "manual" : trigger;
    const last = Math.max(0, ...recent.map((r) => r.claimedAt ?? r.scheduledFor));
    const gap = WEBVIEW_MIN_GAP_MS[effective];
    if (last + gap > now) return { kind: "wait" as const, reason: "too_soon" as const, retryAt: last + gap };

    const runId = pending
      ? pending._id
      : await ctx.db.insert("instagram_runs", {
          deviceId: device._id,
          trigger,
          scheduledFor: now,
          state: "pending",
          budget: WEBVIEW_BUDGET,
        });
    await ctx.db.patch(runId, { state: "claimed", claimedAt: now, budget: WEBVIEW_BUDGET });

    const cursors: { home?: CursorOut; following?: CursorOut; stories?: CursorOut } = {};
    for (const variant of ["home", "following", "stories"] as const) {
      const row = await ctx.db
        .query("instagram_feedCursors")
        .withIndex("by_deviceId_and_variant", (q) => q.eq("deviceId", device._id).eq("variant", variant))
        .unique();
      if (row) {
        const { endCursor, hasNextPage, newestId, newestAt } = row;
        cursors[variant] = { endCursor, hasNextPage, newestId, newestAt };
      }
    }
    const known = await ctx.db
      .query("posts")
      .withIndex("by_userId_and_createdAt", (q) => q.eq("userId", userId))
      .order("desc")
      .take(300);
    return {
      kind: "run" as const,
      runId,
      trigger: effective,
      budget: WEBVIEW_BUDGET,
      cursors,
      knownIds: known.filter((p) => p.platform === "instagram").map((p) => p.id),
    };
  },
});

type CursorOut = { endCursor?: string; hasNextPage: boolean; newestId?: string; newestAt?: number };

async function claimedRun(ctx: MutationCtx, runId: Id<"instagram_runs">) {
  const userId = await requireUserId(ctx);
  const device = await userDevice(ctx, userId);
  const run = await ctx.db.get(runId);
  if (!device || !run || run.deviceId !== device._id) throw new Error("Run not found");
  if (run.state !== "claimed") throw new Error(`Run is ${run.state}`);
  return { device, run, accountId: await ownedAccount(ctx, device) };
}

export const generateUploadUrl = mutation({
  args: { runId: v.id("instagram_runs") },
  returns: v.string(),
  handler: async (ctx, { runId }) => {
    await claimedRun(ctx, runId);
    return await ctx.storage.generateUploadUrl();
  },
});

const vItemMedia = v.object({
  ...vMedia.fields,
  // The phone's own upload (generateUploadUrl) of this media; without one,
  // ingest's media persistence copies url later.
  storageId: v.optional(v.id("_storage")),
});

const vItem = v.object({
  id: v.string(),
  author: vPerson,
  createdAt: v.string(),
  text: v.string(),
  permalink: v.string(),
  format: v.union(v.literal("post"), v.literal("story")),
  expiresAt: v.optional(v.string()),
  extracted: vPostInput.fields.extracted,
  media: v.array(vItemMedia),
  facts: vFacts,
});

// Streams captured items into ingest as they arrive, and records how far the
// feed has been read.
export const submit = mutation({
  args: {
    runId: v.id("instagram_runs"),
    items: v.array(vItem),
    feedPage: v.optional(
      v.object({
        variant: vFeedVariant,
        endCursor: v.optional(v.string()),
        hasNextPage: v.boolean(),
        newestId: v.optional(v.string()),
        newestAt: v.optional(v.number()),
      }),
    ),
  },
  returns: v.number(),
  handler: async (ctx, { runId, items, feedPage }) => {
    const { device, run, accountId } = await claimedRun(ctx, runId);
    if (await killSwitch(ctx)) throw new Error("Instagram kill switch is on");
    const posts: PostInput[] = [];
    for (const { media, facts, ...item } of items) {
      posts.push({
        ...item,
        platform: "instagram",
        sponsored: facts.sponsored,
        suggested: facts.suggested,
        media: await Promise.all(
          media.map(async (m) => {
            if (m.storageId === undefined) {
              const { storageId: _none, ...rest } = m;
              return rest;
            }
            const { storageId, ...rest } = await ownUpload(ctx, device, run, item.id, {
              ...m,
              storageId: m.storageId,
            });
            return { ...rest, url: m.url, storageId };
          }),
        ),
      });
      await upsertFacts(ctx, device, runId, item.id, facts);
    }
    if (posts.length) await ctx.runMutation(internal.ingest.upsertPosts, { accountId, posts });
    if (feedPage) {
      const { variant, newestId, newestAt, ...page } = feedPage;
      const row = await ctx.db
        .query("instagram_feedCursors")
        .withIndex("by_deviceId_and_variant", (q) => q.eq("deviceId", device._id).eq("variant", variant))
        .unique();
      const doc = {
        deviceId: device._id,
        variant,
        ...page,
        newestId: newestId ?? row?.newestId,
        newestAt: newestAt ?? row?.newestAt,
        updatedAt: Date.now(),
      };
      if (row) await ctx.db.replace(row._id, doc);
      else await ctx.db.insert("instagram_feedCursors", doc);
    }
    return posts.length;
  },
});

export const finish = mutation({
  args: {
    runId: v.id("instagram_runs"),
    stats: vRunStats,
    tripwire: v.optional(vTripwire),
    error: v.optional(v.string()),
    caughtUp: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { runId, ...outcome }) => {
    const { device, accountId } = await claimedRun(ctx, runId);
    await finishClaimedRun(ctx, device, accountId, runId, outcome);
    return null;
  },
});

// What the web view needs to know before and during a refresh. Reactive: the
// app aborts a running refresh as soon as killSwitch turns on.
export const state = query({
  args: {},
  returns: v.object({
    connected: v.boolean(),
    accountStatus: v.optional(v.string()),
    // The Instagram identity this user connected (Person.id), so the app
    // never reads another account whose cookies the phone holds.
    meId: v.optional(v.string()),
    killSwitch: v.boolean(),
    pausedUntil: v.optional(v.number()),
    pauseReason: v.optional(v.string()),
  }),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const device = await userDevice(ctx, userId);
    const account = device?.accountId ? await ctx.db.get(device.accountId) : null;
    return {
      connected: device?.transport === "webview" && account !== null,
      accountStatus: account?.status,
      meId: account?.me?.id,
      killSwitch: (await killSwitch(ctx)) !== null,
      pausedUntil: device?.pausedUntil,
      pauseReason: device?.pauseReason,
    };
  },
});
