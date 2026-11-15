import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireUserId } from "./lib/auth";
import { deletePost } from "./lib/posts";
import {
  vAccountStatus,
  vConnectorError,
  vPerson,
  vPlatform,
  vSession,
  type Session,
} from "./lib/validators";

const PURGE_BATCH = 100;

// The app's view of a connected account. Never includes the session.
export const vAccountView = v.object({
  platform: vPlatform,
  me: v.optional(vPerson),
  status: vAccountStatus,
  lastError: v.optional(vConnectorError),
  lastSyncedAt: v.optional(v.number()),
});

export async function listAccounts(ctx: QueryCtx, userId: Id<"users">) {
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
}

export const list = query({
  args: {},
  returns: v.array(vAccountView),
  handler: async (ctx) => listAccounts(ctx, await requireUserId(ctx)),
});

// Called by the app after a webview or OAuth login. Replaces any previous
// session for that platform. The session may belong to a different platform
// identity than before, so the account is "pending" until the connector
// confirms who it is with verifyIdentity. Device sessions are refused here:
// a deviceId is a pointer into a connector's table, so only the connector,
// after checking the device belongs to the user, may store one (connectDevice).
export const connect = mutation({
  args: { session: vSession },
  returns: v.id("connectedAccounts"),
  handler: async (ctx, { session }) => {
    const userId = await requireUserId(ctx);
    if (session.kind === "device") {
      throw new Error("Device sessions can only be connected by their connector's pairing flow");
    }
    return await writeSession(ctx, userId, session);
  },
});

// For connector pairing code: stores a device session for userId. The caller
// must first confirm that deviceId is a row of its own device table owned by
// userId, and must still check that ownership in its sync path.
export const connectDevice = internalMutation({
  args: { userId: v.id("users"), platform: vPlatform, deviceId: v.string() },
  returns: v.id("connectedAccounts"),
  handler: async (ctx, { userId, platform, deviceId }) =>
    await writeSession(ctx, userId, { platform, kind: "device", deviceId }),
});

async function writeSession(ctx: MutationCtx, userId: Id<"users">, session: Session) {
  const existing = await ctx.db
    .query("connectedAccounts")
    .withIndex("by_userId_and_platform", (q) =>
      q.eq("userId", userId).eq("platform", session.platform),
    )
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, {
      session,
      sessionVersion: (existing.sessionVersion ?? 0) + 1,
      status: "pending",
      lastError: undefined,
    });
    return existing._id;
  }
  return await ctx.db.insert("connectedAccounts", {
    userId,
    platform: session.platform,
    session,
    sessionVersion: 1,
    status: "pending",
  });
}

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

// Deletes a user's cached posts (with their stored media and states),
// conversations and messages of one platform in batches, then marks the account (if any) active again.
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
    for (const post of posts) await deletePost(ctx, post);
    for (const doc of [...conversations, ...messages]) await ctx.db.delete(doc._id);
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
// Pass expectedVersion, the sessionVersion of the account the connector read
// (internal.accounts.get) before refreshing: if the session was replaced since
// (the user reconnected, or another refresh landed), the write is refused with
// { saved: false } instead of overwriting the newer session. Without
// expectedVersion the write always goes through.
export const saveSession = internalMutation({
  args: {
    accountId: v.id("connectedAccounts"),
    session: vSession,
    expectedVersion: v.optional(v.number()),
  },
  returns: v.union(
    v.object({ saved: v.literal(true), sessionVersion: v.number() }),
    v.object({
      saved: v.literal(false),
      reason: v.literal("session_changed"),
      sessionVersion: v.number(),
    }),
  ),
  handler: async (ctx, { accountId, session, expectedVersion }) => {
    const account = await ctx.db.get(accountId);
    if (!account) throw new Error("Connected account not found");
    if (session.platform !== account.platform) {
      throw new Error(`Session for ${session.platform} on a ${account.platform} account`);
    }
    if (session.kind === "device") {
      throw new Error("Device sessions can only be stored with connectDevice");
    }
    const current = account.sessionVersion ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== current) {
      return { saved: false as const, reason: "session_changed" as const, sessionVersion: current };
    }
    await ctx.db.patch(accountId, { session, sessionVersion: current + 1 });
    return { saved: true as const, sessionVersion: current + 1 };
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
