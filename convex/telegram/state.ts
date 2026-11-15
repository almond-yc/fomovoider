import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type QueryCtx, internalMutation, internalQuery, mutation } from "../_generated/server";
import { requireUserId } from "../lib/auth";

const SYNC_LEASE_MS = 10 * 60 * 1000;
const REQUEST_SYNC_MIN_INTERVAL_MS = 30 * 1000;
// A session nobody points to anymore (disconnected, or replaced by a new
// login) is logged out after this grace period, which also covers the gap
// between creating a session and accounts.connect in the login action.
const ORPHAN_GRACE_MS = 10 * 60 * 1000;
const CLEANUP_BATCH = 50;

// Everything a sync needs: the account and, when the account's deviceId
// names a Telegram session of the same user, its encrypted session string.
export const load = internalQuery({
  args: { accountId: v.id("connectedAccounts") },
  handler: async (ctx, { accountId }) => {
    const account = await ctx.db.get(accountId);
    if (!account) return null;
    return { account, session: await ownedSession(ctx, account.userId, account.session) };
  },
});

async function ownedSession(ctx: QueryCtx, userId: Id<"users">, session: { kind: string; deviceId?: string }) {
  if (session.kind !== "device" || !session.deviceId) return null;
  const id = ctx.db.normalizeId("telegram_sessions", session.deviceId);
  const row = id && (await ctx.db.get(id));
  // accounts.connect accepts any deviceId, so a session is only used for the
  // user who created it.
  return row && row.userId === userId ? { _id: row._id, secret: row.secret } : null;
}

export const getPeers = internalQuery({
  args: { sessionId: v.id("telegram_sessions"), keys: v.array(v.string()) },
  returns: v.record(v.string(), v.string()),
  handler: async (ctx, { sessionId, keys }) => {
    const out: Record<string, string> = {};
    for (const peer of keys) {
      const row = await ctx.db
        .query("telegram_peers")
        .withIndex("by_sessionId_and_peer", (q) => q.eq("sessionId", sessionId).eq("peer", peer))
        .unique();
      if (row) out[peer] = row.accessHash;
    }
    return out;
  },
});

export const putPeers = internalMutation({
  args: { sessionId: v.id("telegram_sessions"), hashes: v.record(v.string(), v.string()) },
  returns: v.null(),
  handler: async (ctx, { sessionId, hashes }) => {
    for (const [peer, accessHash] of Object.entries(hashes)) {
      const row = await ctx.db
        .query("telegram_peers")
        .withIndex("by_sessionId_and_peer", (q) => q.eq("sessionId", sessionId).eq("peer", peer))
        .unique();
      if (!row) await ctx.db.insert("telegram_peers", { sessionId, peer, accessHash });
      else if (row.accessHash !== accessHash) await ctx.db.patch(row._id, { accessHash });
    }
    return null;
  },
});

// What is stored for the given conversations, so a sync rewrites only the
// ones that changed and fetches only messages newer than the stored last one.
export const storedConversations = internalQuery({
  args: { userId: v.id("users"), ids: v.array(v.string()) },
  returns: v.record(
    v.string(),
    v.object({ lastMessageId: v.optional(v.string()), unreadCount: v.optional(v.number()), title: v.optional(v.string()), updatedAt: v.number() }),
  ),
  handler: async (ctx, { userId, ids }) => {
    const out: Record<string, { lastMessageId?: string; unreadCount?: number; title?: string; updatedAt: number }> = {};
    for (const id of ids) {
      const row = await ctx.db
        .query("conversations")
        .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", id))
        .unique();
      if (row) out[id] = { lastMessageId: row.lastMessage?.id, unreadCount: row.unreadCount, title: row.title, updatedAt: row.updatedAt };
    }
    return out;
  },
});

async function lockOf(ctx: QueryCtx, accountId: Id<"connectedAccounts">) {
  return await ctx.db
    .query("telegram_sync_locks")
    .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
    .unique();
}

// Takes the account's sync lease; false while another sync holds it or a
// FLOOD_WAIT hasn't passed.
export const claimSync = internalMutation({
  args: { accountId: v.id("connectedAccounts") },
  returns: v.boolean(),
  handler: async (ctx, { accountId }) => {
    const lock = await lockOf(ctx, accountId);
    const now = Date.now();
    if (lock && lock.leaseUntil > now) return false;
    if (lock) await ctx.db.patch(lock._id, { leaseUntil: now + SYNC_LEASE_MS });
    else await ctx.db.insert("telegram_sync_locks", { accountId, leaseUntil: now + SYNC_LEASE_MS });
    return true;
  },
});

// Releases the lease, or keeps it until `until` (Telegram's retry time).
export const releaseSync = internalMutation({
  args: { accountId: v.id("connectedAccounts"), until: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { accountId, until }) => {
    const lock = await lockOf(ctx, accountId);
    if (lock) await ctx.db.patch(lock._id, { leaseUntil: until ?? 0 });
    return null;
  },
});

// Cron entry point: one scheduled sync per Telegram account.
export const syncAll = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const accounts = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_platform", (q) => q.eq("platform", "telegram"))
      .collect();
    for (const account of accounts) {
      if (account.status === "expired" || account.status === "resetting") continue;
      await ctx.scheduler.runAfter(0, internal.telegram.sync.syncAccount, { accountId: account._id });
    }
    return null;
  },
});

// For the app: sync now (opening the Chats tab, pull to refresh). False when
// a sync ran or was requested in the last 30 seconds, or one is running.
export const requestSync = mutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const account = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId).eq("platform", "telegram"))
      .unique();
    if (!account || account.status === "expired" || account.status === "resetting") return false;
    const lock = await lockOf(ctx, account._id);
    const now = Date.now();
    if (lock && (lock.leaseUntil > now || (lock.requestedAt && now - lock.requestedAt < REQUEST_SYNC_MIN_INTERVAL_MS))) return false;
    if (lock) await ctx.db.patch(lock._id, { requestedAt: now });
    else await ctx.db.insert("telegram_sync_locks", { accountId: account._id, leaseUntil: 0, requestedAt: now });
    await ctx.scheduler.runAfter(0, internal.telegram.sync.syncAccount, { accountId: account._id });
    return true;
  },
});

export const getLogin = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) =>
    await ctx.db
      .query("telegram_logins")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique(),
});

// Replaces the user's login in progress.
export const saveLogin = internalMutation({
  args: { userId: v.id("users"), secret: v.string(), expiresAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { userId, secret, expiresAt }) => {
    const existing = await ctx.db
      .query("telegram_logins")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (existing) await ctx.db.patch(existing._id, { secret, expiresAt });
    else await ctx.db.insert("telegram_logins", { userId, secret, expiresAt });
    return null;
  },
});

export const deleteLogin = internalMutation({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    const existing = await ctx.db
      .query("telegram_logins")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});

export const createSession = internalMutation({
  args: { userId: v.id("users"), secret: v.string(), telegramUserId: v.string() },
  returns: v.id("telegram_sessions"),
  handler: async (ctx, args) => await ctx.db.insert("telegram_sessions", { ...args, createdAt: Date.now() }),
});

// Hourly: drops expired logins, and logs out and deletes sessions no
// account points to (after accounts.disconnect, or replaced by a new login).
export const cleanup = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("telegram_logins")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(CLEANUP_BATCH);
    for (const login of expired) await ctx.db.delete(login._id);

    const accounts = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_platform", (q) => q.eq("platform", "telegram"))
      .collect();
    const inUse = new Set(accounts.map((a) => (a.session.kind === "device" ? a.session.deviceId : "")));
    const sessions = await ctx.db.query("telegram_sessions").collect();
    for (const session of sessions) {
      if (inUse.has(session._id) || now - session.createdAt < ORPHAN_GRACE_MS) continue;
      const peers = await ctx.db
        .query("telegram_peers")
        .withIndex("by_sessionId_and_peer", (q) => q.eq("sessionId", session._id))
        .take(1000);
      for (const peer of peers) await ctx.db.delete(peer._id);
      if (peers.length === 1000) continue;
      await ctx.db.delete(session._id);
      await ctx.scheduler.runAfter(0, internal.telegram.sync.logOut, { secret: session.secret });
    }
    return null;
  },
});
