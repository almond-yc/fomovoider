import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { vMessage } from "../lib/validators";
import type { ConnectorError } from "../../src/connectors/types";
import { killSwitch } from "./common";
import { localMessageId, threadRow } from "./dms";
import { DM_MAX_TEXT_LENGTH } from "./limits";

// Instagram's half of the inbox's send path (convex/chat/connectors.ts). The
// message is stored right away as pending and queued for the phone, whose
// hidden web view types it into the chat's composer on instagram.com and
// taps Send; dms.complete then flips it to sent or failed. Failures here
// throw a ConvexError carrying a ConnectorError.

const fail = (error: ConnectorError) => new ConvexError(error);

export const message = internalMutation({
  args: { accountId: v.id("connectedAccounts"), conversationId: v.string(), text: v.string() },
  returns: vMessage,
  handler: async (ctx, { accountId, conversationId, text }): Promise<Infer<typeof vMessage>> => {
    const account = await ctx.db.get(accountId);
    if (!account || account.platform !== "instagram") throw fail({ kind: "platform", message: "Instagram is not connected" });
    if (account.status === "expired") throw fail({ kind: "session_expired" });
    if (account.status !== "active" || !account.me) {
      throw fail({ kind: "platform", message: "Instagram is still connecting. Try again in a minute." });
    }
    if (await killSwitch(ctx)) throw fail({ kind: "platform", message: "Instagram is paused right now." });
    const body = text.trim();
    if (!body) throw fail({ kind: "platform", message: "Message is empty" });
    if (body.length > DM_MAX_TEXT_LENGTH) {
      throw fail({ kind: "platform", message: `Instagram messages can be up to ${DM_MAX_TEXT_LENGTH} characters.` });
    }
    const userId = account.userId;
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", conversationId))
      .unique();
    if (!conversation || !(await threadRow(ctx, userId, conversationId))) {
      throw fail({ kind: "platform", message: "This chat isn't in your Instagram inbox." });
    }

    const now = Date.now();
    const outboxId = await ctx.db.insert("instagram_outbox", {
      userId,
      accountId,
      conversationId,
      kind: "send",
      text: body,
      state: "pending",
      createdAt: now,
    });
    const id = localMessageId(outboxId);
    await ctx.db.patch(outboxId, { messageId: id });
    const sent = {
      id,
      conversationId,
      sender: account.me,
      isMine: true,
      sentAt: now,
      text: body,
      media: [],
      delivery: { status: "pending" as const },
    };
    await ctx.runMutation(internal.ingest.upsertMessages, {
      accountId,
      messages: [{ ...sent, sentAt: new Date(now).toISOString() }],
    });
    await ctx.db.patch(conversation._id, { lastMessage: sent, updatedAt: Math.max(conversation.updatedAt, now) });
    return sent;
  },
});

// Queues a seen receipt: the phone opens the chat on instagram.com, which
// marks it seen the way opening it in Instagram does. One pending per chat.
export const markRead = internalMutation({
  args: { accountId: v.id("connectedAccounts"), conversationId: v.string() },
  returns: v.null(),
  handler: async (ctx, { accountId, conversationId }) => {
    const account = await ctx.db.get(accountId);
    if (!account || account.platform !== "instagram" || account.status !== "active") return null;
    const userId = account.userId;
    if (!(await threadRow(ctx, userId, conversationId))) return null;
    const queued = await ctx.db
      .query("instagram_outbox")
      .withIndex("by_userId_and_conversationId_and_kind_and_state", (q) =>
        q.eq("userId", userId).eq("conversationId", conversationId).eq("kind", "markRead").eq("state", "pending"),
      )
      .first();
    if (queued) return null;
    await ctx.db.insert("instagram_outbox", {
      userId,
      accountId,
      conversationId,
      kind: "markRead",
      state: "pending",
      createdAt: Date.now(),
    });
    return null;
  },
});
