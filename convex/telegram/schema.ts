import { defineTable } from "convex/server";
import { v } from "convex/values";

// Telegram-only tables, spread into convex/schema.ts.
export const telegramTables = {
  // A logged-in Telegram session. connectedAccounts holds only
  // { kind: "device", deviceId: <this row's id> }; the session string (a full
  // login to the account) lives here, AES-GCM encrypted with
  // TELEGRAM_SESSION_KEY. Never returned by a public function.
  telegram_sessions: defineTable({
    userId: v.id("users"),
    secret: v.string(),
    telegramUserId: v.string(),
    createdAt: v.number(),
  }).index("by_userId", ["userId"]),

  // A login in progress (QR or phone code, then 2FA), one per user. The
  // pending session already holds an auth key, so it is encrypted too.
  telegram_logins: defineTable({
    userId: v.id("users"),
    secret: v.string(),
    expiresAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_expiresAt", ["expiresAt"]),

  // Access hashes Telegram needs to address a user or supergroup, per session
  // and peer key ("user:123", "channel:456").
  telegram_peers: defineTable({
    sessionId: v.id("telegram_sessions"),
    peer: v.string(),
    accessHash: v.string(),
  }).index("by_sessionId_and_peer", ["sessionId", "peer"]),

  // Per session and conversation: how far its history is stored. Messages
  // up to syncedThrough (a Telegram message number) are in `messages`. While
  // a long catch-up is cut off by the per-run cap, pendingTop is where it
  // ends and pendingCursor where the next run resumes. Previews written by
  // send and markRead never move it.
  telegram_history: defineTable({
    sessionId: v.id("telegram_sessions"),
    conversationId: v.string(),
    syncedThrough: v.number(),
    pendingTop: v.optional(v.number()),
    pendingCursor: v.optional(v.string()),
  }).index("by_sessionId_and_conversationId", ["sessionId", "conversationId"]),

  // One sync at a time per account, the last app request (requestSync's rate
  // limit), and Telegram's FLOOD_WAIT, which holds the lease until it passes.
  telegram_sync_locks: defineTable({
    accountId: v.id("connectedAccounts"),
    leaseUntil: v.number(),
    requestedAt: v.optional(v.number()),
  }).index("by_accountId", ["accountId"]),
};
