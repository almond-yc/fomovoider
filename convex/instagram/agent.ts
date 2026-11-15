import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { vMedia, vPerson, vPostInput, type PostInput } from "../lib/validators";
import { deviceForToken } from "./common";
import { STALE_CLAIM_MS, TRIPWIRE_PAUSE_MS } from "./limits";
import { vRunStats, vTripwire } from "./schema";

// Public functions the host agent on the user's Mac calls with its device
// token. The agent holds no schedule and no state: it redeems a pairing code
// once, then claims runs, uploads captures and reports back.

export const redeemPairing = mutation({
  args: { code: v.string(), tokenHash: v.string() },
  returns: v.object({ deviceId: v.id("instagram_devices") }),
  handler: async (ctx, { code, tokenHash }) => {
    const device = await ctx.db
      .query("instagram_devices")
      .withIndex("by_pairingCode", (q) => q.eq("pairingCode", code))
      .unique();
    if (!device || (device.pairingExpiresAt ?? 0) < Date.now()) {
      throw new Error("Invalid or expired pairing code");
    }
    if (device.pairingArmedBy !== device.userId) throw new Error("Pairing was not armed by the device owner");
    const accountId = await ctx.runMutation(internal.accounts.connectDevice, {
      userId: device.userId,
      platform: "instagram",
      deviceId: device._id,
    });
    await ctx.db.patch(device._id, {
      tokenHash,
      accountId,
      pairingCode: undefined,
      pairingExpiresAt: undefined,
      pairingArmedBy: undefined,
      lastSeenAt: Date.now(),
    });
    return { deviceId: device._id };
  },
});

const vClaimed = v.union(
  v.object({ kind: v.literal("idle") }),
  v.object({ kind: v.literal("paused"), until: v.number(), reason: v.optional(v.string()) }),
  v.object({
    kind: v.literal("run"),
    runId: v.id("instagram_runs"),
    trigger: v.string(),
    budget: v.object({ maxMs: v.number(), maxPosts: v.number(), maxStoryFrames: v.number() }),
    knownIds: v.array(v.string()),
  }),
);

export const claimRun = mutation({
  args: { token: v.string() },
  returns: vClaimed,
  handler: async (ctx, { token }) => {
    const device = await deviceForToken(ctx, token);
    const now = Date.now();
    await ctx.db.patch(device._id, { lastSeenAt: now });
    const stale = await ctx.db
      .query("instagram_runs")
      .withIndex("by_deviceId_and_state_and_scheduledFor", (q) =>
        q.eq("deviceId", device._id).eq("state", "claimed"),
      )
      .collect();
    for (const run of stale) {
      if ((run.claimedAt ?? 0) < now - STALE_CLAIM_MS) {
        await ctx.db.patch(run._id, { state: "failed", finishedAt: now, error: "agent never finished" });
      }
    }
    if (stale.some((run) => (run.claimedAt ?? 0) >= now - STALE_CLAIM_MS)) return { kind: "idle" as const };
    const due = await ctx.db
      .query("instagram_runs")
      .withIndex("by_deviceId_and_state_and_scheduledFor", (q) =>
        q.eq("deviceId", device._id).eq("state", "pending").lte("scheduledFor", now),
      )
      .first();
    if (device.pausedUntil !== undefined && device.pausedUntil > now) {
      if (due) await ctx.db.patch(due._id, { state: "skipped", finishedAt: now, error: "device paused" });
      return { kind: "paused" as const, until: device.pausedUntil, reason: device.pauseReason };
    }
    if (!due || !device.accountId) return { kind: "idle" as const };
    await ownedAccount(ctx, device);
    await ctx.db.patch(due._id, { state: "claimed", claimedAt: now });
    // Recent post ids, so the agent can stop scrolling once it reaches posts
    // it already captured.
    const known = await ctx.db
      .query("posts")
      .withIndex("by_userId_and_createdAt", (q) => q.eq("userId", device.userId))
      .order("desc")
      .take(200);
    return {
      kind: "run" as const,
      runId: due._id,
      trigger: due.trigger,
      budget: due.budget,
      knownIds: known.filter((p) => p.platform === "instagram").map((p) => p.id),
    };
  },
});

// The account a device writes to must be its owner's Instagram account and
// hold this device's session.
async function ownedAccount(ctx: QueryCtx, device: Doc<"instagram_devices">) {
  if (!device.accountId) throw new Error("Device has no connected account");
  const account = await ctx.db.get(device.accountId);
  if (
    !account ||
    account.userId !== device.userId ||
    account.platform !== "instagram" ||
    account.session.kind !== "device" ||
    account.session.deviceId !== device._id
  ) {
    throw new Error("Device is not connected to its owner's Instagram account");
  }
  return account._id;
}

async function claimedRun(ctx: MutationCtx, token: string, runId: Id<"instagram_runs">) {
  const device = await deviceForToken(ctx, token);
  const run = await ctx.db.get(runId);
  if (!run || run.deviceId !== device._id) throw new Error("Run not found");
  if (run.state !== "claimed") throw new Error(`Run is ${run.state}`);
  return { device, run, accountId: await ownedAccount(ctx, device) };
}

export const generateUploadUrl = mutation({
  args: { token: v.string() },
  returns: v.string(),
  handler: async (ctx, { token }) => {
    await deviceForToken(ctx, token);
    return await ctx.storage.generateUploadUrl();
  },
});

// account().me, read from the phone's profile tab. Must come before any ingest.
export const reportIdentity = mutation({
  args: { token: v.string(), runId: v.id("instagram_runs"), me: vPerson },
  returns: v.string(),
  handler: async (ctx, { token, runId, me }) => {
    const { accountId } = await claimedRun(ctx, token, runId);
    await ctx.runMutation(internal.accounts.verifyIdentity, { accountId, me });
    const account = await ctx.db.get(accountId);
    return account?.status ?? "missing";
  },
});

const vCapturedMedia = v.object({
  storageId: v.id("_storage"),
  kind: vMedia.fields.kind,
  width: v.optional(v.number()),
  height: v.optional(v.number()),
  altText: v.optional(v.string()),
});

const vCapturedItem = v.object({
  id: v.string(),
  author: vPerson,
  createdAt: v.string(),
  text: v.string(),
  permalink: v.string(),
  format: v.union(v.literal("post"), v.literal("story")),
  expiresAt: v.optional(v.string()),
  extracted: vPostInput.fields.extracted,
  media: v.array(vCapturedMedia),
  facts: v.object({
    sponsored: v.boolean(),
    suggested: v.boolean(),
    isReel: v.boolean(),
    followsAuthor: v.optional(v.boolean()),
    storyTrayPosition: v.optional(v.number()),
  }),
});

export const submitItems = mutation({
  args: { token: v.string(), runId: v.id("instagram_runs"), items: v.array(vCapturedItem) },
  returns: v.number(),
  handler: async (ctx, { token, runId, items }) => {
    const { device, accountId } = await claimedRun(ctx, token, runId);
    const posts: PostInput[] = [];
    for (const { media, facts, ...item } of items) {
      posts.push({
        ...item,
        platform: "instagram",
        media: await Promise.all(
          media.map(async ({ storageId, ...rest }) => {
            const url = await ctx.storage.getUrl(storageId);
            if (!url) throw new Error(`Upload ${storageId} not found`);
            return { ...rest, url };
          }),
        ),
      });
      await upsertFacts(ctx, device, runId, item.id, facts);
    }
    await ctx.runMutation(internal.ingest.upsertPosts, { accountId, posts });
    return posts.length;
  },
});

async function upsertFacts(
  ctx: MutationCtx,
  device: Doc<"instagram_devices">,
  runId: Id<"instagram_runs">,
  postId: string,
  facts: Omit<Doc<"instagram_postFacts">, "_id" | "_creationTime" | "userId" | "postId" | "runId">,
) {
  const existing = await ctx.db
    .query("instagram_postFacts")
    .withIndex("by_userId_and_postId", (q) => q.eq("userId", device.userId).eq("postId", postId))
    .unique();
  const doc = { userId: device.userId, postId, runId, ...facts };
  if (existing) await ctx.db.replace(existing._id, doc);
  else await ctx.db.insert("instagram_postFacts", doc);
}

export const finishRun = mutation({
  args: {
    token: v.string(),
    runId: v.id("instagram_runs"),
    stats: vRunStats,
    tripwire: v.optional(vTripwire),
    error: v.optional(v.string()),
    // True only when the feed reached posts captured by earlier runs.
    caughtUp: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { token, runId, stats, tripwire, error, caughtUp }) => {
    const { device, accountId } = await claimedRun(ctx, token, runId);
    const now = Date.now();
    const state = tripwire ? "aborted" : error ? "failed" : "done";
    await ctx.db.patch(runId, { state, finishedAt: now, stats, tripwire, error });
    if (tripwire) {
      const pausedUntil = now + TRIPWIRE_PAUSE_MS;
      await ctx.db.patch(device._id, { pausedUntil, pauseReason: `${tripwire.kind}: ${tripwire.screenText.slice(0, 200)}` });
      await ctx.runMutation(internal.accounts.recordSync, {
        accountId,
        error:
          tripwire.kind === "suspicious"
            ? { kind: "rate_limited", retryAt: new Date(pausedUntil).toISOString() }
            : { kind: "session_expired" },
      });
      return null;
    }
    if (error) {
      await ctx.runMutation(internal.accounts.recordSync, { accountId, error: { kind: "platform", message: error } });
      return null;
    }
    const account = await ctx.db.get(accountId);
    if (account?.status === "pending" || account?.status === "resetting") return null;
    await ctx.runMutation(internal.ingest.upsertPosts, {
      accountId,
      posts: [],
      page: { cursor: String(runId), caughtUp: caughtUp ?? false },
    });
    await ctx.runMutation(internal.accounts.recordSync, { accountId });
    return null;
  },
});
