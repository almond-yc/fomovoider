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
};
