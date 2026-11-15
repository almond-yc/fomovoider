import { paginationOptsValidator } from "convex/server";
import { ConvexError, type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { CHAT_PLATFORMS, sendBlocker } from "./chat/connectors";
import { requireUserId } from "./lib/auth";
import { vConnectorError, vMessage } from "./lib/validators";
import type { ConnectorError } from "../src/connectors/types";

type SendResult = { ok: true; message: Infer<typeof vMessage> } | { ok: false; error: ConnectorError };

// Messages of one of the caller's conversations, newest first.
export const list = query({
  args: { conversationId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { conversationId, paginationOpts }) => {
    const userId = await requireUserId(ctx);
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", conversationId))
      .unique();
    if (!conversation) throw new Error("Conversation not found");
    return await ctx.db
      .query("messages")
      .withIndex("by_userId_and_conversationId_and_sentAt", (q) =>
        q.eq("userId", userId).eq("conversationId", conversationId),
      )
      .order("desc")
      .paginate(paginationOpts);
  },
});

// The caller's conversation and the connected account of its platform.
export const target = internalQuery({
  args: { userId: v.id("users"), conversationId: v.string() },
  handler: async (
    ctx,
    { userId, conversationId },
  ): Promise<{ conversation: Doc<"conversations">; account: Doc<"connectedAccounts"> | null }> => {
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", conversationId))
      .unique();
    if (!conversation) throw new Error("Conversation not found");
    const account = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_userId_and_platform", (q) =>
        q.eq("userId", userId).eq("platform", conversation.platform),
      )
      .unique();
    return { conversation, account };
  },
});

// Marks the account expired after a send was refused for an expired session,
// unless the session changed since the send read it (the user reconnected, or
// a refresh was saved, meanwhile).
export const expireSession = internalMutation({
  args: { accountId: v.id("connectedAccounts"), sessionVersion: v.number() },
  returns: v.null(),
  handler: async (ctx, { accountId, sessionVersion }) => {
    const account = await ctx.db.get(accountId);
    if (!account || (account.sessionVersion ?? 0) !== sessionVersion) return null;
    await ctx.db.patch(accountId, { status: "expired", lastError: { kind: "session_expired" } });
    return null;
  },
});

export const clearUnread = internalMutation({
  args: { conversationId: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, { conversationId }) => {
    const conversation = await ctx.db.get(conversationId);
    if (conversation?.unreadCount) await ctx.db.patch(conversationId, { unreadCount: 0 });
    return null;
  },
});

// Sends one text message through the conversation's platform (its
// registered send action stores the message and moves the preview).
// Failures come back as a ConnectorError for the app to show; nothing here
// retries a send.
export const send = action({
  args: { conversationId: v.string(), text: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), message: vMessage }),
    v.object({ ok: v.literal(false), error: vConnectorError }),
  ),
  handler: async (ctx, { conversationId, text }): Promise<SendResult> => {
    const userId = await requireUserId(ctx);
    if (!text.trim()) return { ok: false as const, error: { kind: "platform" as const, message: "Message is empty" } };
    const { conversation, account } = await ctx.runQuery(internal.messages.target, { userId, conversationId });
    const blocked = sendBlocker(conversation, account);
    if (blocked || !account) return { ok: false as const, error: blocked ?? { kind: "session_expired" as const } };

    try {
      const message = await CHAT_PLATFORMS[account.platform]!.send(ctx, account, conversationId, text);
      return { ok: true as const, message };
    } catch (err) {
      const error = toConnectorError(err);
      if (error.kind === "session_expired") {
        await ctx.runMutation(internal.messages.expireSession, {
          accountId: account._id,
          sessionVersion: account.sessionVersion ?? 0,
        });
      }
      return { ok: false as const, error };
    }
  },
});

// Marks the conversation read on its platform, where it supports that (X
// does not). Best effort: a failure is logged, never shown.
export const markRead = action({
  args: { conversationId: v.string() },
  returns: v.null(),
  handler: async (ctx, { conversationId }) => {
    const userId = await requireUserId(ctx);
    const { conversation, account } = await ctx.runQuery(internal.messages.target, { userId, conversationId });
    if (!account || account.status !== "active" || conversation.unavailable) return null;
    const markRead = CHAT_PLATFORMS[account.platform]?.markRead;
    if (!markRead) return null;
    try {
      await markRead(ctx, account, conversationId);
      await ctx.runMutation(internal.messages.clearUnread, { conversationId: conversation._id });
    } catch (err) {
      console.error("markRead failed", err);
    }
    return null;
  },
});

const CONNECTOR_ERROR_KINDS = new Set<ConnectorError["kind"]>([
  "session_expired",
  "rate_limited",
  "budget_exhausted",
  "unsupported",
  "network",
  "platform",
]);

function toConnectorError(err: unknown): ConnectorError {
  const data = err instanceof ConvexError ? (err.data as { kind?: unknown }) : undefined;
  if (data && CONNECTOR_ERROR_KINDS.has(data.kind as ConnectorError["kind"])) return data as ConnectorError;
  console.error("Send failed", err);
  return { kind: "platform", message: "Something went wrong sending this message." };
}
