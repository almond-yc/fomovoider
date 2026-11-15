import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireUserId } from "./lib/auth";
import { vAccountStatus, vConnectorError, vPerson, vPlatform, vSession } from "./lib/validators";

// The app's view of a connected account. Never includes the session.
export const list = query({
  args: {},
  returns: v.array(
    v.object({
      platform: vPlatform,
      me: v.optional(vPerson),
      status: vAccountStatus,
      lastError: v.optional(vConnectorError),
      lastSyncedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const accounts = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId))
      .collect();
    return accounts.map(({ platform, me, status, lastError, lastSyncedAt }) => ({
      platform,
      me,
      status,
      lastError,
      lastSyncedAt,
    }));
  },
});

// Called by the app after a webview or OAuth login. Replaces any previous
// session for that platform.
export const connect = mutation({
  args: { session: vSession },
  returns: v.id("connectedAccounts"),
  handler: async (ctx, { session }) => {
    const userId = await requireUserId(ctx);
    const existing = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_userId_and_platform", (q) =>
        q.eq("userId", userId).eq("platform", session.platform),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { session, status: "active", lastError: undefined });
      return existing._id;
    }
    return await ctx.db.insert("connectedAccounts", {
      userId,
      platform: session.platform,
      session,
      status: "active",
    });
  },
});

export const disconnect = mutation({
  args: { platform: vPlatform },
  returns: v.null(),
  handler: async (ctx, { platform }) => {
    const userId = await requireUserId(ctx);
    const account = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_userId_and_platform", (q) =>
        q.eq("userId", userId).eq("platform", platform),
      )
      .unique();
    if (account) await ctx.db.delete(account._id);
    return null;
  },
});

// For connector sync actions: the account with its session.
export const get = internalQuery({
  args: { accountId: v.id("connectedAccounts") },
  handler: async (ctx, { accountId }) => await ctx.db.get(accountId),
});

// For connector crons: every account of one platform.
export const listByPlatform = internalQuery({
  args: { platform: vPlatform },
  handler: async (ctx, { platform }) =>
    await ctx.db
      .query("connectedAccounts")
      .withIndex("by_platform", (q) => q.eq("platform", platform))
      .collect(),
});

// Persists a session a connector refreshed mid-call (onSessionRefreshed).
export const saveSession = internalMutation({
  args: { accountId: v.id("connectedAccounts"), session: vSession },
  returns: v.null(),
  handler: async (ctx, { accountId, session }) => {
    const account = await ctx.db.get(accountId);
    if (!account) throw new Error("Connected account not found");
    if (session.platform !== account.platform) {
      throw new Error(`Session for ${session.platform} on a ${account.platform} account`);
    }
    await ctx.db.patch(accountId, { session });
    return null;
  },
});

// Records the outcome of a sync. A success clears the error and stamps
// lastSyncedAt; session_expired marks the account expired so the app shows
// a reconnect banner.
export const recordSync = internalMutation({
  args: {
    accountId: v.id("connectedAccounts"),
    me: v.optional(vPerson),
    error: v.optional(vConnectorError),
  },
  returns: v.null(),
  handler: async (ctx, { accountId, me, error }) => {
    const account = await ctx.db.get(accountId);
    if (!account) throw new Error("Connected account not found");
    if (error) {
      await ctx.db.patch(accountId, {
        status: error.kind === "session_expired" ? "expired" : "error",
        lastError: error,
      });
      return null;
    }
    await ctx.db.patch(accountId, {
      status: "active",
      lastError: undefined,
      lastSyncedAt: Date.now(),
      ...(me ? { me } : {}),
    });
    return null;
  },
});
