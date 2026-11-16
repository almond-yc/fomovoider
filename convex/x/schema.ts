import { defineTable } from "convex/server";
import { v } from "convex/values";

// X-only tables, spread into convex/schema.ts.
export const xTables = {
  // Incremental sync position per connected account. Reset when the X
  // identity behind the account changes.
  x_sync_state: defineTable({
    accountId: v.id("connectedAccounts"),
    xUserId: v.string(),
    dmSinceId: v.optional(v.string()),
    dmCursor: v.optional(v.string()),
    dmPassNewestId: v.optional(v.string()),
    chatSince: v.optional(v.string()),
    chatCursor: v.optional(v.string()),
    chatPassNewestAt: v.optional(v.string()),
  }).index("by_accountId", ["accountId"]),

  // One sync at a time per account: a lease taken when a sync starts, and
  // the last app-requested sync for requestSync's rate limit.
  x_sync_locks: defineTable({
    accountId: v.id("connectedAccounts"),
    leaseUntil: v.number(),
    requestedAt: v.optional(v.number()),
  }).index("by_accountId", ["accountId"]),

  // The connector's daily read and write budget (UsageStore), one row per
  // "x:<xUserId>:<kind>:<UTC date>" key.
  x_usage: defineTable({ key: v.string(), used: v.number() }).index("by_key", ["key"]),

  // Encrypted X Chat events, stored as X sent them: the source the server
  // (or a phone) decrypts from, so nothing is paid to X twice. kind "key"
  // rows are the conversation key changes X returns in meta.
  x_chat_events: defineTable({
    userId: v.id("users"),
    xUserId: v.string(),
    conversationId: v.string(),
    kind: v.union(v.literal("event"), v.literal("key")),
    eventId: v.string(),
    sortKey: v.string(),
    encodedEvent: v.string(),
    keyVersion: v.optional(v.string()),
    senderId: v.optional(v.string()),
    createdAt: v.optional(v.string()),
  })
    .index("by_userId_and_conversationId_and_kind_and_sortKey", ["userId", "conversationId", "kind", "sortKey"])
    .index("by_userId_and_eventId", ["userId", "eventId"]),

  // The app's X Activity webhook on this deployment (one row), from
  // x/webhook:register.
  x_webhook: defineTable({ webhookId: v.string(), url: v.string() }),

  // Per connected account: its X Activity subscription ids, and until when
  // they are removed because the daily event cap was reached.
  x_webhook_accounts: defineTable({
    accountId: v.id("connectedAccounts"),
    xUserId: v.string(),
    subscriptionIds: v.array(v.string()),
    pausedUntil: v.optional(v.number()),
  })
    .index("by_accountId", ["accountId"])
    .index("by_xUserId", ["xUserId"]),

  // Delivered webhook events by event_uuid, so a redelivery is dropped.
  x_webhook_events: defineTable({ eventId: v.string(), receivedAt: v.number() })
    .index("by_eventId", ["eventId"])
    .index("by_receivedAt", ["receivedAt"]),

  // Per X Chat conversation: the newest event fully synced (sinceId), and an
  // unfinished pass from newest to older that later fetches continue.
  x_chat_cursors: defineTable({
    userId: v.id("users"),
    xUserId: v.string(),
    conversationId: v.string(),
    sinceId: v.optional(v.string()),
    cursor: v.optional(v.string()),
    passNewestId: v.optional(v.string()),
    retry: v.optional(v.boolean()),
  }).index("by_userId_and_conversationId", ["userId", "conversationId"]),

  // Per connected X account: the X Chat private keys, exported once from the
  // passcode and encrypted with X_CHAT_KEY_ENCRYPTION_KEY (AES-256-GCM, bound
  // to the account and X identity). Only internal functions read this table;
  // no public function returns encryptedKeys. "invalid" keeps no keys: X
  // rejected them (the user changed their X Chat keys) and the passcode must
  // be entered again.
  x_chat_keys: defineTable({
    accountId: v.id("connectedAccounts"),
    userId: v.id("users"),
    xUserId: v.string(),
    status: v.union(v.literal("active"), v.literal("invalid")),
    encryptedKeys: v.optional(v.string()),
    signingKeyVersion: v.optional(v.string()),
    invalidReason: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_accountId", ["accountId"])
    .index("by_userId", ["userId"])
    .index("by_xUserId", ["xUserId"]),

  // Public X Chat signing keys per X user (as GET /2/users/{id}/public_keys
  // returns them), cached so decrypting doesn't pay X for them every run.
  x_chat_public_keys: defineTable({
    xUserId: v.string(),
    keys: v.array(
      v.object({
        userId: v.string(),
        publicKeyVersion: v.string(),
        publicKey: v.string(),
        identityPublicKey: v.string(),
        identityPublicKeySignature: v.string(),
      }),
    ),
    fetchedAt: v.number(),
  }).index("by_xUserId", ["xUserId"]),
};
