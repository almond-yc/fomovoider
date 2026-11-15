import { paginationOptsValidator } from "convex/server";
import { type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { type ActionCtx, action, internalMutation, internalQuery, query } from "./_generated/server";
import { CHAT_PLATFORMS, sendBlocker } from "./chat/connectors";
import { requireUserId } from "./lib/auth";
import { epochMs } from "./lib/normalize";
import { vConnectorError, vMessage } from "./lib/validators";
import { ConnectorFailure, type ConnectorError, type Id, type Message, type Session } from "../src/connectors/types";

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

// Moves the conversation's preview to a message the user just sent.
export const touchConversation = internalMutation({
  args: { userId: v.id("users"), message: vMessage },
  returns: v.null(),
  handler: async (ctx, { userId, message }) => {
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", message.conversationId))
      .unique();
    if (!conversation || conversation.updatedAt > message.sentAt) return null;
    await ctx.db.patch(conversation._id, { lastMessage: message, updatedAt: message.sentAt });
    return null;
  },
});

// Marks the account expired after a send was refused for an expired session,
// unless the session was replaced since (the user reconnected meanwhile).
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

// Sends one text message through the conversation's platform connector and
// stores what the platform returned. Failures come back as a ConnectorError
// for the app to show; nothing here retries a send.
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

    const session = await sessionTracker(ctx, account);
    let sent: Message;
    try {
      const connector = CHAT_PLATFORMS[account.platform]!.create(ctx, account, session.refreshed);
      sent = await connector.send(account.session as Session, conversationId as Id, { text });
      await session.saved();
    } catch (err) {
      await session.saved().catch(() => undefined);
      const error = toConnectorError(err);
      if (error.kind === "session_expired" && !session.stale()) {
        await ctx.runMutation(internal.messages.expireSession, {
          accountId: account._id,
          sessionVersion: session.version(),
        });
      }
      return { ok: false as const, error };
    }

    const { raw: _raw, ...contract } = sent;
    const message = { ...contract, sentAt: epochMs(contract.sentAt) };
    try {
      await ctx.runMutation(internal.ingest.upsertMessages, { accountId: account._id, messages: [contract] });
      await ctx.runMutation(internal.messages.touchConversation, { userId, message });
    } catch (err) {
      // The platform accepted the message, so this is still a success; the next sync stores it.
      console.error("Sent message could not be stored", err);
    }
    return { ok: true as const, message };
  },
});

// Marks the conversation read on its platform, where the connector supports
// it (X does not). Best effort: a failure is logged, never shown.
export const markRead = action({
  args: { conversationId: v.string() },
  returns: v.null(),
  handler: async (ctx, { conversationId }) => {
    const userId = await requireUserId(ctx);
    const { conversation, account } = await ctx.runQuery(internal.messages.target, { userId, conversationId });
    if (!account || account.status !== "active" || conversation.unavailable) return null;
    const platform = CHAT_PLATFORMS[account.platform];
    if (!platform) return null;
    const session = await sessionTracker(ctx, account);
    const connector = platform.create(ctx, account, session.refreshed);
    if (!connector.markRead) return null;
    try {
      await connector.markRead(account.session as Session, conversationId as Id);
      await session.saved();
      await ctx.runMutation(internal.messages.clearUnread, { conversationId: conversation._id });
    } catch (err) {
      await session.saved().catch(() => undefined);
      console.error("markRead failed", err);
    }
    return null;
  },
});

// Persists sessions a connector refreshes mid-call, unless the user reconnected meanwhile.
async function sessionTracker(ctx: ActionCtx, account: Doc<"connectedAccounts">) {
  let saving: Promise<unknown> = Promise.resolve();
  let version = account.sessionVersion ?? 0;
  let stale = false;
  return {
    refreshed: (next: Session) => {
      saving = saving.then(async () => {
        const result = await ctx.runMutation(internal.accounts.saveSession, {
          accountId: account._id,
          session: next as Doc<"connectedAccounts">["session"],
          expectedVersion: version,
        });
        if (result.saved) version = result.sessionVersion;
        else stale = true;
      });
    },
    saved: () => saving,
    version: () => version,
    stale: () => stale,
  };
}

function toConnectorError(err: unknown): ConnectorError {
  if (err instanceof ConnectorFailure) return err.error;
  console.error("Send failed", err);
  return { kind: "platform", message: "Something went wrong sending this message." };
}
