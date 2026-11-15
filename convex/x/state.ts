import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation, internalQuery } from "../_generated/server";

const syncStateFields = {
  dmSinceId: v.optional(v.string()),
  dmCursor: v.optional(v.string()),
  dmPassNewestId: v.optional(v.string()),
  chatSince: v.optional(v.string()),
  chatCursor: v.optional(v.string()),
  chatPassNewestAt: v.optional(v.string()),
};

// Everything a sync needs to start: the account with its session, the feed
// cursor, and this X identity's sync position.
export const load = internalQuery({
  args: { accountId: v.id("connectedAccounts") },
  handler: async (ctx, { accountId }) => {
    const account = await ctx.db.get(accountId);
    if (!account) return null;
    const cursor = await ctx.db
      .query("feedCursors")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", account.userId).eq("platform", account.platform))
      .unique();
    const state = await ctx.db
      .query("x_sync_state")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .unique();
    return { account, feedCursor: cursor?.cursor, state: state && state.xUserId === account.me?.id ? state : null };
  },
});

// Patches the sync position, starting a fresh one when the X identity changed.
// Convex drops undefined argument fields, so a finished DM pass clears its
// cursor with endDmPass rather than undefined values.
export const saveState = internalMutation({
  args: {
    accountId: v.id("connectedAccounts"),
    xUserId: v.string(),
    patch: v.object(syncStateFields),
    endDmPass: v.optional(v.boolean()),
    endChatPass: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { accountId, xUserId, patch: fields, endDmPass, endChatPass }) => {
    let patch = endDmPass ? { ...fields, dmCursor: undefined, dmPassNewestId: undefined } : fields;
    if (endChatPass) patch = { ...patch, chatCursor: undefined, chatPassNewestAt: undefined };
    const existing = await ctx.db
      .query("x_sync_state")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .unique();
    if (existing && existing.xUserId === xUserId) {
      await ctx.db.patch(existing._id, patch);
      return null;
    }
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("x_sync_state", { accountId, xUserId, ...patch });
    return null;
  },
});

// Ids of the given conversations that are new or newer than what is stored,
// so an older DM page never overwrites a conversation's lastMessage.
export const newerConversations = internalQuery({
  args: {
    userId: v.id("users"),
    conversations: v.array(v.object({ id: v.string(), updatedAt: v.string() })),
  },
  returns: v.array(v.string()),
  handler: async (ctx, { userId, conversations }) => {
    const newer: string[] = [];
    for (const { id, updatedAt } of conversations) {
      const existing = await ctx.db
        .query("conversations")
        .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", id))
        .unique();
      if (!existing || existing.updatedAt <= Date.parse(updatedAt)) newer.push(id);
    }
    return newer;
  },
});

const SYNC_LEASE_MS = 10 * 60 * 1000;

async function lockOf(ctx: QueryCtx, accountId: Id<"connectedAccounts">) {
  return await ctx.db
    .query("x_sync_locks")
    .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
    .unique();
}

// Takes the account's sync lease; false while another sync holds it. The
// lease outlives any action (10 minutes), so a crashed sync can't block.
export const claimSync = internalMutation({
  args: { accountId: v.id("connectedAccounts") },
  returns: v.boolean(),
  handler: async (ctx, { accountId }) => {
    const lock = await lockOf(ctx, accountId);
    const now = Date.now();
    if (lock && lock.leaseUntil > now) return false;
    if (lock) await ctx.db.patch(lock._id, { leaseUntil: now + SYNC_LEASE_MS });
    else await ctx.db.insert("x_sync_locks", { accountId, leaseUntil: now + SYNC_LEASE_MS });
    return true;
  },
});

export const releaseSync = internalMutation({
  args: { accountId: v.id("connectedAccounts") },
  returns: v.null(),
  handler: async (ctx, { accountId }) => {
    const lock = await lockOf(ctx, accountId);
    if (lock) await ctx.db.patch(lock._id, { leaseUntil: 0 });
    return null;
  },
});

// Records an app request to sync unless one ran or was requested within
// minIntervalMs, or a sync is running. Shared by requestSync.
export async function recordSyncRequest(ctx: MutationCtx, accountId: Id<"connectedAccounts">, minIntervalMs: number) {
  const lock = await lockOf(ctx, accountId);
  const now = Date.now();
  if (lock && (lock.leaseUntil > now || (lock.requestedAt && now - lock.requestedAt < minIntervalMs))) return false;
  if (lock) await ctx.db.patch(lock._id, { requestedAt: now });
  else await ctx.db.insert("x_sync_locks", { accountId, leaseUntil: 0, requestedAt: now });
  return true;
}

export const usageUsed = internalQuery({
  args: { key: v.string() },
  returns: v.number(),
  handler: async (ctx, { key }) =>
    (await ctx.db.query("x_usage").withIndex("by_key", (q) => q.eq("key", key)).unique())?.used ?? 0,
});

// Atomic: Convex mutations are serializable, so concurrent syncs can't both
// take the last of the budget.
export const usageReserve = internalMutation({
  args: { key: v.string(), amount: v.number(), limit: v.number() },
  returns: v.number(),
  handler: async (ctx, { key, amount, limit }) => {
    const row = await ctx.db.query("x_usage").withIndex("by_key", (q) => q.eq("key", key)).unique();
    const used = row?.used ?? 0;
    const granted = Math.max(0, Math.min(amount, limit - used));
    if (row) await ctx.db.patch(row._id, { used: used + granted });
    else await ctx.db.insert("x_usage", { key, used: granted });
    return granted;
  },
});

export const usageRelease = internalMutation({
  args: { key: v.string(), amount: v.number() },
  returns: v.null(),
  handler: async (ctx, { key, amount }) => {
    const row = await ctx.db.query("x_usage").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (row && amount > 0) await ctx.db.patch(row._id, { used: Math.max(0, row.used - amount) });
    return null;
  },
});
