"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { type ActionCtx, internalAction } from "../_generated/server";
import { vConnectorError, vMessageInput } from "../lib/validators";
import { ConnectorFailure, type Conversation, type Message, type Person, type Session } from "../../src/connectors/types";
import { messageId, parseConversationId } from "../../src/connectors/telegram/ids";
import type { TelegramConnector } from "../../src/connectors/telegram/connector";
import { decryptSecret } from "./secret";
import { telegramAuth, telegramConnector, toConnectorError } from "./runtime";

// Per run: the chat list is read page by page until CONVERSATION_LIMIT
// supported chats (or MAX_DIALOG_PAGES pages of Telegram dialogs, which
// include broadcast channels the connector leaves out). Each chat whose
// history moved past its checkpoint, or whose preview changed, is updated;
// at most HISTORY_PER_RUN a run, the rest wait for the next one. A chat seen
// for the first time brings its newest FIRST_HISTORY messages; a known one
// everything after its checkpoint, MAX_NEW_MESSAGES a run, resuming where the
// last run stopped.
export const CONVERSATION_LIMIT = 50;
export const MAX_DIALOG_PAGES = 5;
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
      await syncChats(ctx, tg, session, account, loaded.session._id);
      await ctx.runMutation(internal.accounts.recordSync, { accountId });
    } catch (err) {
      const error = toConnectorError(err);
      if (error.kind === "rate_limited" && error.retryAt) until = Date.parse(error.retryAt);
      if (await sameSession(ctx, account)) await ctx.runMutation(internal.accounts.recordSync, { accountId, error });
    } finally {
      await tg?.close();
      await ctx.runMutation(internal.telegram.state.releaseSync, { accountId, until });
    }
    return null;
  },
});

// False once the user reconnected (connectDevice bumps sessionVersion): an
// outcome from the old session must not touch the new one, or a stale error
// would clear "pending" and skip the new identity's verification.
async function sameSession(ctx: ActionCtx, account: Doc<"connectedAccounts">) {
  const current = await ctx.runQuery(internal.accounts.get, { accountId: account._id });
  return (current?.sessionVersion ?? 0) === (account.sessionVersion ?? 0);
}

type Checkpoint = { syncedThrough: number; pendingTop?: number; pendingCursor?: string };

async function syncChats(ctx: ActionCtx, tg: TelegramConnector, session: Session, account: Doc<"connectedAccounts">, sessionId: Id<"telegram_sessions">) {
  const accountId = account._id;
  const chats: { conversation: Conversation; topMessageId: number }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_DIALOG_PAGES && chats.length < CONVERSATION_LIMIT; page++) {
    const res = await tg.chats(session, { cursor, limit: 100 });
    chats.push(...res.items);
    if (res.caughtUp) break;
    cursor = res.cursor;
  }
  const items = chats.slice(0, CONVERSATION_LIMIT);
  const ids = items.map((c) => c.conversation.id);
  const stored = await ctx.runQuery(internal.telegram.state.storedConversations, { userId: account.userId, ids });
  const checkpoints = await ctx.runQuery(internal.telegram.state.historyCheckpoints, { sessionId, ids });
  const historyMoved = ({ conversation, topMessageId }: (typeof items)[number]) => {
    const cp = checkpoints[conversation.id];
    return !cp || cp.pendingTop !== undefined || topMessageId > cp.syncedThrough;
  };
  const changed = items
    .filter((item) => {
      const s = stored[item.conversation.id];
      const c = item.conversation;
      return historyMoved(item) || !s || s.lastMessageId !== c.lastMessage?.id || s.unreadCount !== c.unreadCount || s.title !== c.title;
    })
    .slice(0, HISTORY_PER_RUN);
  for (const item of changed) {
    if (!historyMoved(item)) continue;
    const { messages, checkpoint } = await fetchHistory(tg, session, item.conversation.id, item.topMessageId, checkpoints[item.conversation.id]);
    if (messages.length) await ctx.runMutation(internal.ingest.upsertMessages, { accountId, messages: messages.map(withoutRaw) });
    await ctx.runMutation(internal.telegram.state.saveCheckpoint, { sessionId, conversationId: item.conversation.id, checkpoint });
  }
  if (changed.length) {
    await ctx.runMutation(internal.ingest.upsertConversations, { accountId, conversations: changed.map((c) => conversationWithoutRaw(c.conversation)) });
  }
}

// The messages to store and the checkpoint to save after storing them.
async function fetchHistory(tg: TelegramConnector, session: Session, id: Conversation["id"], top: number, cp: Checkpoint | undefined): Promise<{ messages: Message[]; checkpoint: Checkpoint }> {
  if (!cp) return { messages: (await tg.messages(session, id, { limit: FIRST_HISTORY })).items, checkpoint: { syncedThrough: top } };
  const target = cp.pendingTop ?? top;
  const after = messageId(parseConversationId(id), cp.syncedThrough);
  const out: Message[] = [];
  let cursor = cp.pendingCursor;
  for (;;) {
    const page = await tg.messages(session, id, { after, cursor, limit: 100 });
    out.push(...page.items);
    if (page.caughtUp) return { messages: out, checkpoint: { syncedThrough: target } };
    cursor = page.cursor;
    if (out.length >= MAX_NEW_MESSAGES) return { messages: out, checkpoint: { syncedThrough: cp.syncedThrough, pendingTop: target, pendingCursor: cursor } };
  }
}

// `raw` holds GramJS byte fields (Uint8Array) that Convex arguments can't
// carry; ingest would drop it anyway.
function withoutRaw(message: Message): Omit<Message, "raw"> {
  const { raw: _raw, ...rest } = message;
  return rest;
}

function conversationWithoutRaw(conversation: Conversation) {
  return conversation.lastMessage ? { ...conversation, lastMessage: withoutRaw(conversation.lastMessage) } : conversation;
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
    await ctx.runMutation(internal.ingest.upsertConversations, { accountId, conversations: [conversationWithoutRaw(conversation)] });
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
    if (error.kind === "session_expired" && (await sameSession(ctx, loaded.account))) await ctx.runMutation(internal.accounts.recordSync, { accountId, error });
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
