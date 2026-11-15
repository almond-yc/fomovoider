"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { type ActionCtx, internalAction } from "../_generated/server";
import { vConnectorError, vMessageInput } from "../lib/validators";
import { ConnectorFailure, type Conversation, type Message, type Person, type Session } from "../../src/connectors/types";
import type { TelegramConnector } from "../../src/connectors/telegram/connector";
import { decryptSecret } from "./secret";
import { telegramAuth, telegramConnector, toConnectorError } from "./runtime";

// Per run: the newest CONVERSATION_LIMIT chats are compared with what is
// stored, and at most HISTORY_PER_RUN changed ones fetch their new messages
// (the rest wait for the next run). A chat seen for the first time brings
// its newest FIRST_HISTORY messages; a known one everything after the stored
// last message, up to MAX_NEW_MESSAGES.
export const CONVERSATION_LIMIT = 50;
export const HISTORY_PER_RUN = 15;
export const FIRST_HISTORY = 20;
export const MAX_NEW_MESSAGES = 200;

export const syncAccount = internalAction({
  args: { accountId: v.id("connectedAccounts") },
  returns: v.null(),
  handler: async (ctx, { accountId }) => {
    const loaded = await ctx.runQuery(internal.telegram.state.load, { accountId });
    if (!loaded || loaded.account.platform !== "telegram") return null;
    const { account } = loaded;
    if (account.status === "expired" || account.status === "resetting") return null;
    if (!(await ctx.runMutation(internal.telegram.state.claimSync, { accountId }))) return null;

    let until: number | undefined;
    let tg: TelegramConnector | undefined;
    try {
      if (!loaded.session) throw new ConnectorFailure({ kind: "session_expired" }, "No Telegram session for this account");
      tg = await telegramConnector(ctx, loaded.session);
      const session = account.session as Session;
      let me = account.me as Person | undefined;
      if (account.status === "pending" || !me) {
        me = (await tg.account(session)).me;
        await ctx.runMutation(internal.accounts.verifyIdentity, { accountId, me });
        if (account.me && account.me.id !== me.id) return null;
      }
      await syncChats(ctx, tg, session, account);
      await ctx.runMutation(internal.accounts.recordSync, { accountId });
    } catch (err) {
      const error = toConnectorError(err);
      if (error.kind === "rate_limited" && error.retryAt) until = Date.parse(error.retryAt);
      await ctx.runMutation(internal.accounts.recordSync, { accountId, error });
    } finally {
      await tg?.close();
      await ctx.runMutation(internal.telegram.state.releaseSync, { accountId, until });
    }
    return null;
  },
});

async function syncChats(ctx: ActionCtx, tg: TelegramConnector, session: Session, account: Doc<"connectedAccounts">) {
  const accountId = account._id;
  const page = await tg.conversations(session, { limit: CONVERSATION_LIMIT });
  const stored = await ctx.runQuery(internal.telegram.state.storedConversations, { userId: account.userId, ids: page.items.map((c) => c.id) });
  const changed = page.items
    .filter((c) => {
      const s = stored[c.id];
      return !s || s.lastMessageId !== c.lastMessage?.id || s.unreadCount !== c.unreadCount || s.title !== c.title;
    })
    .slice(0, HISTORY_PER_RUN);
  for (const conversation of changed) {
    const known = stored[conversation.id]?.lastMessageId;
    if (!conversation.lastMessage || conversation.lastMessage.id === known) continue;
    const messages = await newMessages(tg, session, conversation, known);
    if (messages.length) await ctx.runMutation(internal.ingest.upsertMessages, { accountId, messages });
  }
  if (changed.length) await ctx.runMutation(internal.ingest.upsertConversations, { accountId, conversations: changed });
}

async function newMessages(tg: TelegramConnector, session: Session, conversation: Conversation, after: string | undefined): Promise<Message[]> {
  if (!after) return (await tg.messages(session, conversation.id, { limit: FIRST_HISTORY })).items;
  const out: Message[] = [];
  let cursor: string | undefined;
  do {
    const page = await tg.messages(session, conversation.id, { after: after as Message["id"], cursor, limit: 100 });
    out.push(...page.items);
    cursor = page.caughtUp ? undefined : page.cursor;
  } while (cursor && out.length < MAX_NEW_MESSAGES);
  return out;
}

const vResult = v.union(v.object({ ok: v.literal(true) }), v.object({ ok: v.literal(false), error: vConnectorError }));

// For the app's send path (messages.send). Sends once, never retries, and
// stores the sent message and the refreshed conversation. Failures come back
// as a ConnectorError; session_expired also marks the account expired.
export const send = internalAction({
  args: { accountId: v.id("connectedAccounts"), conversationId: v.string(), text: v.string() },
  returns: v.union(v.object({ ok: v.literal(true), message: vMessageInput }), v.object({ ok: v.literal(false), error: vConnectorError })),
  handler: async (ctx, { accountId, conversationId, text }) =>
    withAccount(ctx, accountId, async (tg, session) => {
      const { raw: _raw, ...message } = await tg.send(session, conversationId as Message["id"], { text });
      await ctx.runMutation(internal.ingest.upsertMessages, { accountId, messages: [message] });
      await refreshConversation(ctx, tg, session, accountId, conversationId);
      return { ok: true as const, message };
    }),
});

// For the app opening a conversation: marks it read on Telegram and stores
// the conversation with its new unread count.
export const markRead = internalAction({
  args: { accountId: v.id("connectedAccounts"), conversationId: v.string() },
  returns: vResult,
  handler: async (ctx, { accountId, conversationId }) =>
    withAccount(ctx, accountId, async (tg, session) => {
      await tg.markRead(session, conversationId as Message["id"]);
      await refreshConversation(ctx, tg, session, accountId, conversationId);
      return { ok: true as const };
    }),
});

async function refreshConversation(ctx: ActionCtx, tg: TelegramConnector, session: Session, accountId: Id<"connectedAccounts">, id: string) {
  try {
    const conversation = await tg.conversation(session, id as Message["id"]);
    await ctx.runMutation(internal.ingest.upsertConversations, { accountId, conversations: [conversation] });
  } catch {
    // The write already happened; the next sync refreshes the conversation.
  }
}

async function withAccount<T>(
  ctx: ActionCtx,
  accountId: Id<"connectedAccounts">,
  run: (tg: TelegramConnector, session: Session) => Promise<T>,
): Promise<T | { ok: false; error: ReturnType<typeof toConnectorError> }> {
  const loaded = await ctx.runQuery(internal.telegram.state.load, { accountId });
  if (!loaded || loaded.account.platform !== "telegram") return { ok: false, error: { kind: "platform", message: "No Telegram account" } };
  if (loaded.account.status !== "active" && loaded.account.status !== "error") {
    return { ok: false, error: loaded.account.status === "expired" ? { kind: "session_expired" } : { kind: "platform", message: `Telegram account is ${loaded.account.status}` } };
  }
  if (!loaded.session) return { ok: false, error: { kind: "session_expired" } };
  const tg = await telegramConnector(ctx, loaded.session);
  try {
    return await run(tg, loaded.account.session as Session);
  } catch (err) {
    const error = toConnectorError(err);
    if (error.kind === "session_expired") await ctx.runMutation(internal.accounts.recordSync, { accountId, error });
    return { ok: false, error };
  } finally {
    await tg.close();
  }
}

// Ends a Telegram session that no account uses anymore (cleanup cron).
export const logOut = internalAction({
  args: { secret: v.string() },
  returns: v.null(),
  handler: async (_ctx, { secret }) => {
    await (await telegramAuth()).logOut(await decryptSecret(secret));
    return null;
  },
});
