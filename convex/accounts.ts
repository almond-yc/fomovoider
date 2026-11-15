import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { requireUserId } from "./lib/auth";
import { vAccountStatus, vConnectorError, vPerson, vPlatform, vSession } from "./lib/validators";

const PURGE_BATCH = 100;

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
// session for that platform. The session may belong to a different platform
// identity than before, so the account is "pending" until the connector
// confirms who it is with verifyIdentity.
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
      await ctx.db.patch(existing._id, { session, status: "pending", lastError: undefined });
      return existing._id;
    }
    return await ctx.db.insert("connectedAccounts", {
      userId,
      platform: session.platform,
      session,
      status: "pending",
    });
  },
});

// Removes the account, its feed cursor, and the platform's cached content.
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
    if (!account) return null;
    await ctx.db.delete(account._id);
    await resetPlatform(ctx, userId, platform);
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

// Confirms which platform identity the session belongs to, from the
// connector's account(). Required while the account is "pending". When the
// identity changed, the previous identity's cursor and cached content are
// dropped; the account is "resetting" (ingest refuses) until that finishes.
export const verifyIdentity = internalMutation({
  args: { accountId: v.id("connectedAccounts"), me: vPerson },
  returns: v.null(),
  handler: async (ctx, { accountId, me }) => {
    const account = await ctx.db.get(accountId);
    if (!account) throw new Error("Connected account not found");
    if (me.platform !== account.platform) {
      throw new Error(`Identity from ${me.platform} on a ${account.platform} account`);
    }
    if (account.me === undefined || account.me.id === me.id) {
      if (account.status !== "resetting") {
        await ctx.db.patch(accountId, { me, status: "active", lastError: undefined });
      }
      return null;
    }
    await ctx.db.patch(accountId, { me, status: "resetting", lastError: undefined });
    await resetPlatform(ctx, account.userId, account.platform, accountId);
    return null;
  },
});

async function resetPlatform(
  ctx: MutationCtx,
  userId: Id<"users">,
  platform: string,
  accountId?: Id<"connectedAccounts">,
) {
  const cursor = await ctx.db
    .query("feedCursors")
    .withIndex("by_userId_and_platform", (q) =>
      q.eq("userId", userId).eq("platform", platform),
    )
    .unique();
  if (cursor) await ctx.db.delete(cursor._id);
  await ctx.scheduler.runAfter(0, internal.accounts.purgeContent, { userId, platform, accountId });
}

// Deletes a user's cached posts, conversations and messages of one platform
// in batches, then marks the account (if any) active again.
export const purgeContent = internalMutation({
  args: {
    userId: v.id("users"),
    platform: vPlatform,
    accountId: v.optional(v.id("connectedAccounts")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { userId, platform, accountId } = args;
    // Ids are namespaced "<platform>:...", and ";" sorts right after ":".
    const from = `${platform}:`;
    const to = `${platform};`;
    const posts = await ctx.db
      .query("posts")
      .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).gte("id", from).lt("id", to))
      .take(PURGE_BATCH);
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).gte("id", from).lt("id", to))
      .take(PURGE_BATCH);
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).gte("id", from).lt("id", to))
      .take(PURGE_BATCH);
    for (const doc of [...posts, ...conversations, ...messages]) await ctx.db.delete(doc._id);
    if (Math.max(posts.length, conversations.length, messages.length) === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.accounts.purgeContent, args);
      return null;
    }
    if (accountId) {
      const account = await ctx.db.get(accountId);
      if (account?.status === "resetting") await ctx.db.patch(accountId, { status: "active" });
    }
    return null;
  },
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
  args: { accountId: v.id("connectedAccounts"), error: v.optional(vConnectorError) },
  returns: v.null(),
  handler: async (ctx, { accountId, error }) => {
    const account = await ctx.db.get(accountId);
    if (!account) throw new Error("Connected account not found");
    if (error) {
      await ctx.db.patch(accountId, {
        status: error.kind === "session_expired" ? "expired" : "error",
        lastError: error,
      });
      return null;
    }
    if (account.status === "pending" || account.status === "resetting") {
      throw new Error(`Account is ${account.status}; call verifyIdentity first`);
    }
    await ctx.db.patch(accountId, { status: "active", lastError: undefined, lastSyncedAt: Date.now() });
    return null;
  },
});
