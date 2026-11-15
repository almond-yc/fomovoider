import { defineTable } from "convex/server";
import { v } from "convex/values";

export const vBudget = v.object({
  maxMs: v.number(),
  maxPosts: v.number(),
  maxStoryFrames: v.number(),
});

export const vRunStats = v.object({
  posts: v.number(),
  storyFrames: v.number(),
  durationMs: v.number(),
});

export const vTripwire = v.object({
  kind: v.union(v.literal("challenge"), v.literal("login"), v.literal("suspicious")),
  screenText: v.string(),
});

export const instagramTables = {
  // One paired phone per user. The host agent authenticates with a token
  // whose SHA-256 is stored here; the token itself never reaches Convex.
  instagram_devices: defineTable({
    userId: v.id("users"),
    name: v.string(),
    accountId: v.optional(v.id("connectedAccounts")),
    tokenHash: v.optional(v.string()),
    pairingCode: v.optional(v.string()),
    pairingExpiresAt: v.optional(v.number()),
    pairingArmedBy: v.optional(v.id("users")),
    timezone: v.string(),
    scheduleEnabled: v.boolean(),
    pausedUntil: v.optional(v.number()),
    pauseReason: v.optional(v.string()),
    lastSeenAt: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_tokenHash", ["tokenHash"])
    .index("by_pairingCode", ["pairingCode"]),

  // One capture session on the phone. Convex decides when and with what
  // budget; the host agent decides how it moves.
  instagram_runs: defineTable({
    deviceId: v.id("instagram_devices"),
    trigger: v.union(v.literal("scheduled"), v.literal("manual")),
    scheduledFor: v.number(),
    state: v.union(
      v.literal("pending"),
      v.literal("claimed"),
      v.literal("done"),
      v.literal("aborted"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    budget: vBudget,
    claimedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    stats: v.optional(vRunStats),
    tripwire: v.optional(vTripwire),
    error: v.optional(v.string()),
  }).index("by_deviceId_and_state_and_scheduledFor", ["deviceId", "state", "scheduledFor"]),

  // Facts the screen showed about a post that have no slot in the shared
  // Post: whether it was an ad or a suggestion, a reel, and whether the
  // user follows the author. Recorded as-is; nothing is filtered here.
  instagram_postFacts: defineTable({
    userId: v.id("users"),
    postId: v.string(),
    runId: v.id("instagram_runs"),
    sponsored: v.boolean(),
    suggested: v.boolean(),
    isReel: v.boolean(),
    followsAuthor: v.optional(v.boolean()),
    storyTrayPosition: v.optional(v.number()),
  }).index("by_userId_and_postId", ["userId", "postId"]),
};
