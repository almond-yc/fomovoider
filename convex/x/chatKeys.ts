import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { requireUserId } from "../lib/auth";

// The X Chat key store. setPasscode (chatNode.ts) checks the passcode with X,
// exports the unlocked private keys and saves them here encrypted. Keys
// belong to the X user (xUserId), not to one app account: every active
// connected account of that X user decrypts, sends and reports status with
// them. accountId is the account that sealed them (bound into the seal). These
// functions never return encryptedKeys to a client: only the internal ones
// below hand the ciphertext to the server's own Node actions.

export const vPasscodeStatus = v.union(v.literal("none"), v.literal("active"), v.literal("invalid"));

async function viewerAccount(ctx: QueryCtx, userId: Id<"users">) {
  return await ctx.db
    .query("connectedAccounts")
    .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId).eq("platform", "x"))
    .unique();
}

async function keysFor(ctx: QueryCtx, xUserId: string) {
  return await ctx.db
    .query("x_chat_keys")
    .withIndex("by_xUserId", (q) => q.eq("xUserId", xUserId))
    .order("desc")
    .first();
}

// "none": no X Chat passcode saved for the viewer's X account; "active":
// server-side X Chat is on; "invalid": X stopped accepting the saved keys, so
// the app should ask for the passcode again.
export const passcodeStatus = query({
  args: {},
  returns: v.object({ status: vPasscodeStatus, reason: v.optional(v.string()) }),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const account = await viewerAccount(ctx, userId);
    if (!account?.me) return { status: "none" as const };
    const row = await keysFor(ctx, account.me.id);
    if (!row) return { status: "none" as const };
    return row.status === "active" ? { status: "active" as const } : { status: "invalid" as const, ...(row.invalidReason ? { reason: row.invalidReason } : {}) };
  },
});

// Deletes the saved X Chat keys of the viewer's currently connected X user,
// for every app account linked to it. Already-decrypted messages stay in the inbox; new X Chat
// messages show as locked until a passcode is set again.
export const removePasscode = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const account = await viewerAccount(ctx, userId);
    if (account?.me) await deleteKeysOf(ctx, account.me.id);
    return null;
  },
});

// Called from accounts.ts when an X account is disconnected or its identity
// changes. Keys go only once no active account of their X user is left, so
// another app account linked to the same X user keeps decrypting. xUserId is
// the identity the account held, when the account row is already gone.
export async function deleteChatKeys(ctx: MutationCtx, userId: Id<"users">, xUserId?: string) {
  const sealed = await ctx.db.query("x_chat_keys").withIndex("by_userId", (q) => q.eq("userId", userId)).collect();
  const xUserIds = new Set([...sealed.map((row) => row.xUserId), ...(xUserId ? [xUserId] : [])]);
  for (const id of xUserIds) {
    const active = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_meId", (q) => q.eq("me.id", id))
      .filter((q) => q.and(q.eq(q.field("platform"), "x"), q.eq(q.field("status"), "active")))
      .first();
    if (!active) await deleteKeysOf(ctx, id);
  }
}

async function deleteKeysOf(ctx: MutationCtx, xUserId: string) {
  const rows = await ctx.db.query("x_chat_keys").withIndex("by_xUserId", (q) => q.eq("xUserId", xUserId)).collect();
  for (const row of rows) await ctx.db.delete(row._id);
}

export const saveKeys = internalMutation({
  args: { accountId: v.id("connectedAccounts"), xUserId: v.string(), encryptedKeys: v.string(), signingKeyVersion: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { accountId, xUserId, encryptedKeys, signingKeyVersion }) => {
    const account = await ctx.db.get(accountId);
    if (!account || account.me?.id !== xUserId) return false;
    await deleteKeysOf(ctx, xUserId);
    await ctx.db.insert("x_chat_keys", { accountId, userId: account.userId, xUserId, status: "active", encryptedKeys, signingKeyVersion, updatedAt: Date.now() });
    return true;
  },
});

export const loadKeys = internalQuery({
  args: { accountId: v.id("connectedAccounts") },
  handler: async (ctx, { accountId }): Promise<Doc<"x_chat_keys"> | null> => {
    const account = await ctx.db.get(accountId);
    if (!account?.me || account.platform !== "x") return null;
    const row = await keysFor(ctx, account.me.id);
    return row?.status === "active" ? row : null;
  },
});

export const keysActive = internalQuery({
  args: { accountId: v.id("connectedAccounts") },
  returns: v.boolean(),
  handler: async (ctx, { accountId }) => {
    const account = await ctx.db.get(accountId);
    return account ? await hasActiveChatKeys(ctx, account) : false;
  },
});

// Whether the server holds working X Chat keys for this account, so it can
// decrypt and send its X Chat conversations (see chat/connectors sendBlocker).
export async function hasActiveChatKeys(ctx: QueryCtx, account: Doc<"connectedAccounts">): Promise<boolean> {
  if (account.platform !== "x" || !account.me) return false;
  return (await keysFor(ctx, account.me.id))?.status === "active";
}

export const markInvalid = internalMutation({
  args: { accountId: v.id("connectedAccounts"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, { accountId, reason }) => {
    const account = await ctx.db.get(accountId);
    const row = account?.me ? await keysFor(ctx, account.me.id) : null;
    if (!row) return null;
    await ctx.db.replace(row._id, { accountId: row.accountId, userId: row.userId, xUserId: row.xUserId, status: "invalid", invalidReason: reason, updatedAt: Date.now() });
    return null;
  },
});

const vSigningKey = v.object({
  userId: v.string(),
  publicKeyVersion: v.string(),
  publicKey: v.string(),
  identityPublicKey: v.string(),
  identityPublicKeySignature: v.string(),
});

export const cachedPublicKeys = internalQuery({
  args: { xUserIds: v.array(v.string()), maxAgeMs: v.number() },
  handler: async (ctx, { xUserIds, maxAgeMs }): Promise<Doc<"x_chat_public_keys">[]> => {
    const now = Date.now();
    const rows: Doc<"x_chat_public_keys">[] = [];
    for (const xUserId of xUserIds) {
      const row = await ctx.db
        .query("x_chat_public_keys")
        .withIndex("by_xUserId", (q) => q.eq("xUserId", xUserId))
        .unique();
      if (row && now - row.fetchedAt <= maxAgeMs) rows.push(row);
    }
    return rows;
  },
});

export const cachePublicKeys = internalMutation({
  args: { entries: v.array(v.object({ xUserId: v.string(), keys: v.array(vSigningKey) })) },
  returns: v.null(),
  handler: async (ctx, { entries }) => {
    for (const { xUserId, keys } of entries) {
      const row = await ctx.db
        .query("x_chat_public_keys")
        .withIndex("by_xUserId", (q) => q.eq("xUserId", xUserId))
        .unique();
      if (row) await ctx.db.replace(row._id, { xUserId, keys, fetchedAt: Date.now() });
      else await ctx.db.insert("x_chat_public_keys", { xUserId, keys, fetchedAt: Date.now() });
    }
    return null;
  },
});
