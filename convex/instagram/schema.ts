import { defineTable } from "convex/server";
import { v } from "convex/values";
import { vPerson } from "../lib/validators";

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

export const vFacts = v.object({
  sponsored: v.boolean(),
  suggested: v.boolean(),
  isReel: v.boolean(),
  paidPartnership: v.optional(v.boolean()),
  followsAuthor: v.optional(v.boolean()),
  storyTrayPosition: v.optional(v.number()),
});

// "stories" holds the story tray's progress: newestAt is the latest reel
// update already fetched.
export const vFeedVariant = v.union(v.literal("home"), v.literal("following"), v.literal("stories"));

export const instagramTables = {
  // Which device and post an uploaded capture belongs to. submitItems binds a
  // file on first use, so no other device or post can adopt it.
  instagram_uploads: defineTable({
    storageId: v.id("_storage"),
    deviceId: v.id("instagram_devices"),
    postId: v.string(),
  }).index("by_storageId", ["storageId"]),

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
    // Who captures for this device: the Mac host agent driving the iPhone app
    // over WebDriverAgent (unset), or the Fomovoider app's hidden web view.
    transport: v.optional(v.literal("webview")),
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
    // open and background are web-view refreshes the app starts itself.
    trigger: v.union(v.literal("scheduled"), v.literal("manual"), v.literal("open"), v.literal("background")),
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
    paidPartnership: v.optional(v.boolean()),
    followsAuthor: v.optional(v.boolean()),
    storyTrayPosition: v.optional(v.number()),
  }).index("by_userId_and_postId", ["userId", "postId"]),

  // Where the web view's reading stopped, per device and variant: the page's
  // own end_cursor of the deepest page captured (informational: it is not a
  // stable cursor across sessions), and the newest post seen at the top, so
  // the next refresh stops once it reaches it.
  instagram_feedCursors: defineTable({
    deviceId: v.id("instagram_devices"),
    variant: vFeedVariant,
    endCursor: v.optional(v.string()),
    hasNextPage: v.boolean(),
    newestId: v.optional(v.string()),
    // taken_at (epoch ms) of newestId, so a refresh can stop by time when
    // that post was deleted.
    newestAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_deviceId_and_variant", ["deviceId", "variant"]),

  // Global switches. "killSwitch" enabled stops every Instagram refresh, web
  // view and host agent alike, at once.
  instagram_flags: defineTable({
    name: v.literal("killSwitch"),
    enabled: v.boolean(),
    reason: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_name", ["name"]),

  // DMs (convex/instagram/dms.ts). One row per Primary inbox thread the web
  // view has seen: the id in its URL, which the phone opens to send or mark
  // it seen, and its members by messaging id, to name message senders.
  instagram_threads: defineTable({
    userId: v.id("users"),
    conversationId: v.string(),
    threadKey: v.string(),
    members: v.array(v.object({ fbid: v.string(), person: vPerson })),
    updatedAt: v.number(),
  }).index("by_userId_and_conversationId", ["userId", "conversationId"]),

  // Per user: the viewer's messaging ids (to tell their own messages apart)
  // and when the web view last loaded the inbox.
  instagram_dmState: defineTable({
    userId: v.id("users"),
    viewerIds: v.array(v.string()),
    lastSyncAt: v.optional(v.number()),
  }).index("by_userId", ["userId"]),

  // Sends and seen receipts waiting for the phone's web view. send.message
  // and send.markRead add them; the web view claims each one, does it
  // through the page and completes it.
  instagram_outbox: defineTable({
    userId: v.id("users"),
    accountId: v.id("connectedAccounts"),
    conversationId: v.string(),
    kind: v.union(v.literal("send"), v.literal("markRead")),
    text: v.optional(v.string()),
    // The pending messages row (instagram:local:<outbox id>) a send shows.
    messageId: v.optional(v.string()),
    state: v.union(v.literal("pending"), v.literal("claimed"), v.literal("done"), v.literal("failed")),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index("by_userId_and_state", ["userId", "state"])
    .index("by_userId_and_conversationId_and_kind_and_state", ["userId", "conversationId", "kind", "state"]),
};
