"use node";

import { createChat, ChatXdkError } from "@xdevplatform/chat-xdk-server";
import { ConvexError, type Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { type ActionCtx, action, internalAction } from "../_generated/server";
import { requireUserId } from "../lib/auth";
import { type ConversationInput, vConversationInput, vMessage } from "../lib/validators";
import { ConnectorFailure, type ConnectorError, type Id as ContractId, type Message, type Person } from "../../src/connectors/types";
import { type ChatSigningKey, UNDECRYPTABLE_TEXT, chatMessages, eventSortKey, realmTokenFrom } from "../../src/connectors/x/chat";
import { XChatEngine, type XdkChat } from "../../src/xchat/engine/core";
import { type XChatConnection, connectXChat } from "./chatConnection";

// Server-side X Chat: the passcode is checked with X once, the private keys
// it unlocks are exported (@xdevplatform/chat-xdk-server) and kept encrypted
// in x_chat_keys, and every later decrypt or send imports them. The passcode
// itself is never stored. See convex/x/README.md, "X Chat".

const DECRYPT_PER_RUN = 10;
const FETCH_PAGES_PER_CONVERSATION = 3;
const PUBLIC_KEYS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OWN_KEYS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const KEYS_CHANGED = "Your X Chat keys changed on X. Enter your X Chat passcode again.";

const vSetPasscodeResult = v.union(
  v.object({ ok: v.literal(true) }),
  v.object({
    ok: v.literal(false),
    error: v.union(
      v.object({ kind: v.literal("wrongPasscode"), guessesRemaining: v.optional(v.number()) }),
      v.object({ kind: v.literal("notSetUp") }),
      v.object({ kind: v.literal("notConnected") }),
      v.object({ kind: v.literal("failed"), message: v.string() }),
    ),
  }),
);

// Checks the X Chat passcode with X (Juicebox) and, when it is right, saves
// the keys it unlocks so X Chat syncs on the server. A wrong passcode is
// never saved and returns how many tries X has left, when X says.
export const setPasscode = action({
  args: { passcode: v.string() },
  returns: vSetPasscodeResult,
  handler: async (ctx, { passcode }) => {
    const userId = await requireUserId(ctx);
    const { account }: { account: Doc<"connectedAccounts"> | null } = await ctx.runQuery(internal.x.chat.accountFor, { userId });
    if (!account?.me || account.status !== "active" || account.session.kind !== "oauth") {
      return { ok: false as const, error: { kind: "notConnected" as const } };
    }
    const meId = account.me.id.slice(2);
    const x = connectXChat(ctx, account);
    let context;
    try {
      context = await x.client.keyContext(x.session(), { meId, participantIds: [] });
    } catch (err) {
      return { ok: false as const, error: { kind: "failed" as const, message: errorText(err) } };
    } finally {
      await x.saving().catch(() => undefined);
    }
    if (!context.juiceboxConfig || !context.signingKeyVersion) return { ok: false as const, error: { kind: "notSetUp" as const } };
    const config = context.juiceboxConfig;
    const chat = await createChat({
      juiceboxConfig: config,
      getAuthToken: async (realmId: string) => {
        const token = realmTokenFrom(config, realmId);
        if (!token) throw new Error("X didn't send a token for one of the key backup servers");
        return token;
      },
    });
    const pin = new TextEncoder().encode(passcode);
    let exported: Uint8Array;
    try {
      await chat.unlock(pin);
      exported = chat.exportKeys();
    } catch (err) {
      if (err instanceof ChatXdkError && err.kind === "invalidPin") {
        return {
          ok: false as const,
          error: { kind: "wrongPasscode" as const, ...(typeof err.guessesRemaining === "number" ? { guessesRemaining: err.guessesRemaining } : {}) },
        };
      }
      return { ok: false as const, error: { kind: "failed" as const, message: errorText(err) } };
    } finally {
      pin.fill(0);
      chat.free();
    }
    try {
      const encryptedKeys = await sealKeys(exported, account._id, account.me.id);
      const saved = await ctx.runMutation(internal.x.chatKeys.saveKeys, {
        accountId: account._id,
        xUserId: account.me.id,
        encryptedKeys,
        signingKeyVersion: context.signingKeyVersion,
      });
      if (!saved) return { ok: false as const, error: { kind: "notConnected" as const } };
    } finally {
      exported.fill(0);
    }
    await cacheSigningKeys(ctx, context.signingKeys);
    const locked = await ctx.runQuery(internal.x.chat.lockedConversations, { accountId: account._id, limit: DECRYPT_PER_RUN });
    if (locked.length) {
      await ctx.scheduler.runAfter(0, internal.x.chatNode.decryptConversations, { accountId: account._id, conversations: locked.map(toInput) });
    }
    return { ok: true as const };
  },
});

// Fetches each conversation's new events, decrypts its stored ones and writes
// plain conversations and messages to the shared tables. Conversations past
// DECRYPT_PER_RUN, or that can't be decrypted, are written as locked rows.
export const decryptConversations = internalAction({
  args: { accountId: v.id("connectedAccounts"), conversations: v.array(vConversationInput) },
  returns: v.null(),
  handler: async (ctx, { accountId, conversations }) => {
    const listed = new Set(conversations.map((c) => c.id));
    const pending = await ctx.runQuery(internal.x.chat.pendingConversations, { accountId, limit: DECRYPT_PER_RUN });
    const queued = [...conversations, ...pending.filter((row) => !listed.has(row.id)).map(toInput)];
    await decrypt(ctx, accountId, queued, true);
    return null;
  },
});

// A webhook delivered a new event for this conversation and it is already
// stored, so it is decrypted without paying X for another event page.
export const decryptDelivered = internalAction({
  args: { accountId: v.id("connectedAccounts"), conversationId: v.string() },
  returns: v.null(),
  handler: async (ctx, { accountId, conversationId }) => {
    const row = await ctx.runQuery(internal.x.chat.conversationRow, { accountId, conversationId });
    if (row) await decrypt(ctx, accountId, [toInput(row)], false);
    return null;
  },
});

// Fetches a conversation's new events, a few pages at most. False when the
// pass didn't finish (budget, error or page cap): the conversation is then
// left locked, and pendingConversations hands it to a later run, which
// resumes from the saved cursor.
async function fetchAll(ctx: ActionCtx, accountId: Id<"connectedAccounts">, conversationId: string): Promise<boolean> {
  try {
    for (let page = 0; page < FETCH_PAGES_PER_CONVERSATION; page++) {
      const { caughtUp } = await ctx.runAction(internal.x.chat.fetchFor, { accountId, conversationId });
      if (caughtUp) return true;
    }
  } catch (err) {
    if (!(err instanceof Error && /budget/i.test(err.message))) console.error("X Chat fetch failed:", errorText(err));
  }
  return false;
}

async function decrypt(ctx: ActionCtx, accountId: Id<"connectedAccounts">, conversations: ConversationInput[], fetch: boolean): Promise<void> {
  const session = await openSession(ctx, accountId);
  if (!session) {
    await ctx.runMutation(internal.ingest.upsertConversations, { accountId, conversations: conversations.map(asLocked) });
    return;
  }
  const locked: ConversationInput[] = [];
  try {
    for (const [i, conversation] of conversations.entries()) {
      if (i >= DECRYPT_PER_RUN) {
        locked.push(asLocked(conversation));
        continue;
      }
      if (fetch && !(await fetchAll(ctx, accountId, conversation.id))) {
        locked.push(asLocked(conversation));
        continue;
      }
      if (!(await decryptOne(ctx, session, conversation))) locked.push(asLocked(conversation));
    }
  } finally {
    session.engine.lock();
  }
  if (locked.length) await ctx.runMutation(internal.ingest.upsertConversations, { accountId, conversations: locked });
}

// One-off backfill, run by hand: npx convex run x/chatNode:backfill
// '{"accountId": "...", "maxReads": 400}'. Fetches and decrypts the account's
// locked and unfinished X Chat conversations, spending at most maxReads chat
// event reads (X bills $0.01 each; public key reads count too) from its own
// cap instead of the daily budget, which the background runs keep using.
export const backfill = internalAction({
  args: { accountId: v.id("connectedAccounts"), maxReads: v.number(), maxConversations: v.optional(v.number()) },
  returns: v.object({ conversations: v.number(), decrypted: v.number(), stillLocked: v.number(), eventsFetched: v.number() }),
  handler: async (ctx, { accountId, maxReads, maxConversations }): Promise<{ conversations: number; decrypted: number; stillLocked: number; eventsFetched: number }> => {
    if (!(maxReads > 0)) throw new Error("maxReads must be a positive number");
    const runId = String(Date.now());
    const pending = await ctx.runQuery(internal.x.chat.pendingConversations, { accountId, limit: maxConversations ?? 100 });
    const session = await openSession(ctx, accountId, { runId, maxReads });
    if (!session) throw new Error("This account has no active X Chat keys");
    let decrypted = 0;
    let eventsFetched = 0;
    const locked: ConversationInput[] = [];
    try {
      for (const row of pending) {
        const conversation = toInput(row);
        let caughtUp = false;
        while (!caughtUp && eventsFetched < maxReads) {
          try {
            const res = await ctx.runAction(internal.x.chat.fetchFor, { accountId, conversationId: conversation.id, backfill: { runId, maxReads } });
            eventsFetched += res.fetched;
            caughtUp = res.caughtUp;
            if (!res.fetched && !caughtUp) break;
          } catch (err) {
            if (!(err instanceof Error && /budget/i.test(err.message))) console.error("X Chat backfill fetch failed:", errorText(err));
            break;
          }
        }
        if (caughtUp && (await decryptOne(ctx, session, conversation))) decrypted++;
        else locked.push(asLocked(conversation));
      }
    } finally {
      session.engine.lock();
    }
    if (locked.length) await ctx.runMutation(internal.ingest.upsertConversations, { accountId, conversations: locked });
    return { conversations: pending.length, decrypted, stillLocked: locked.length, eventsFetched };
  },
});

// messages.send for an X Chat conversation (via x/send:message): encrypts on
// the server with the saved keys, sends, then syncs the conversation so the
// sent message lands in the messages table, and returns it.
export const send = internalAction({
  args: { accountId: v.id("connectedAccounts"), conversationId: v.string(), text: v.string() },
  returns: vMessage,
  handler: async (ctx, args): Promise<Infer<typeof vMessage>> => {
    try {
      return await sendWithKeys(ctx, args);
    } catch (err) {
      if (err instanceof ConvexError) throw err;
      if (err instanceof ConnectorFailure) throw new ConvexError<ConnectorError>(err.error);
      throw new ConvexError<ConnectorError>({ kind: "platform", message: errorText(err) });
    }
  },
});

async function sendWithKeys(
  ctx: ActionCtx,
  { accountId, conversationId, text }: { accountId: Id<"connectedAccounts">; conversationId: string; text: string },
): Promise<Infer<typeof vMessage>> {
  const session = await openSession(ctx, accountId);
  if (!session) throw new ConnectorFailure({ kind: "platform", message: "Enter your X Chat passcode in Settings to send X Chat messages" });
  try {
    const row = await ctx.runQuery(internal.x.chat.conversationRow, { accountId, conversationId });
    if (!row) throw new ConnectorFailure({ kind: "platform", message: "Conversation not found" });
    const conversation = toInput(row);
    let stored = await ctx.runQuery(internal.x.chat.storedEvents, { accountId, conversationId });
    if (!stored?.rows.length) {
      await ctx.runAction(internal.x.chat.fetchFor, { accountId, conversationId });
      stored = await ctx.runQuery(internal.x.chat.storedEvents, { accountId, conversationId });
    }
    await useSigningKeys(ctx, session, conversation);
    session.engine.decrypt(conversationId, stored?.rows ?? [], stored?.keyEvents ?? []);
    const before = new Set((stored?.rows ?? []).map((row) => `x:${row.id}`));
    const payload = session.engine.encrypt(conversationId, text);
    try {
      await session.x.client.send(session.x.session(), conversationId as ContractId, { meId: session.meId, payload });
    } finally {
      await session.x.saving();
    }
    await ctx.runAction(internal.x.chat.fetchFor, { accountId, conversationId }).catch(() => undefined);
    const messages = (await decryptOne(ctx, session, conversation)) ?? [];
    const sent = messages.find((m) => m.isMine && m.text === text && !before.has(m.id));
    if (sent) return { ...sent, sentAt: Date.parse(sent.sentAt) };
    const now = new Date().toISOString();
    const fallback = {
      id: `x:${payload.messageId}` as ContractId,
      conversationId: conversationId as ContractId,
      sender: session.me,
      isMine: true,
      sentAt: now,
      text,
      media: [],
    };
    await ctx.runMutation(internal.ingest.upsertMessages, { accountId, messages: [fallback] });
    const shown = { ...fallback, sentAt: Date.parse(now) };
    await ctx.runMutation(internal.x.state.showMessage, { accountId, message: shown });
    return shown;
  } finally {
    session.engine.lock();
  }
}

type ServerSession = {
  accountId: Id<"connectedAccounts">;
  meId: string;
  me: Person;
  engine: XChatEngine;
  x: XChatConnection;
  signingKeys: Map<string, ChatSigningKey>;
};

// Imports the account's saved keys into a chat engine, or null when there are
// none. If X now lists a newer key for the account than the saved one, the
// saved keys are marked invalid and null is returned.
async function openSession(ctx: ActionCtx, accountId: Id<"connectedAccounts">, backfill?: { runId: string; maxReads: number }): Promise<ServerSession | null> {
  const row: Doc<"x_chat_keys"> | null = await ctx.runQuery(internal.x.chatKeys.loadKeys, { accountId });
  const account: Doc<"connectedAccounts"> | null = await ctx.runQuery(internal.accounts.get, { accountId });
  if (!row?.encryptedKeys || !row.signingKeyVersion || !account?.me || account.session.kind !== "oauth") return null;
  const meId = account.me.id.slice(2);
  const x = connectXChat(ctx, account, backfill);
  const own = await signingKeysFor(ctx, x, meId, [meId], OWN_KEYS_MAX_AGE_MS);
  const newest = own
    .filter((k) => k.userId === meId)
    .map((k) => k.publicKeyVersion)
    .sort((a, b) => (eventSortKey(a) < eventSortKey(b) ? 1 : -1))[0];
  if (newest && newest !== row.signingKeyVersion) {
    await ctx.runMutation(internal.x.chatKeys.markInvalid, { accountId, reason: KEYS_CHANGED });
    return null;
  }
  const keys = await openKeys(row.encryptedKeys, accountId, account.me.id);
  const chat = await createChat();
  try {
    chat.importKeys({ keys, signingKeyVersion: row.signingKeyVersion });
  } catch (err) {
    chat.free();
    await ctx.runMutation(internal.x.chatKeys.markInvalid, { accountId, reason: KEYS_CHANGED });
    console.error("X Chat key import failed:", errorText(err));
    return null;
  } finally {
    keys.fill(0);
  }
  const engine = new XChatEngine(async () => {
    throw new Error("The server never unlocks with a passcode");
  });
  engine.adopt(chat as unknown as XdkChat, { meId, signingKeyVersion: row.signingKeyVersion, signingKeys: own });
  return { accountId, meId, me: account.me as Person, engine, x, signingKeys: new Map(own.map((k) => [`${k.userId}:${k.publicKeyVersion}`, k])) };
}

async function useSigningKeys(ctx: ActionCtx, session: ServerSession, conversation: ConversationInput) {
  const ids = conversation.participants.map((p) => p.id.slice(2));
  const keys = await signingKeysFor(ctx, session.x, session.meId, ids, PUBLIC_KEYS_MAX_AGE_MS);
  for (const k of keys) session.signingKeys.set(`${k.userId}:${k.publicKeyVersion}`, k);
  session.engine.setSigningKeys([...session.signingKeys.values()]);
}

// Decrypts one conversation's stored events and upserts it with its messages,
// which it returns; null when nothing could be decrypted.
async function decryptOne(ctx: ActionCtx, session: ServerSession, conversation: ConversationInput): Promise<Message[] | null> {
  try {
    const stored = await ctx.runQuery(internal.x.chat.storedEvents, { accountId: session.accountId, conversationId: conversation.id });
    if (!stored?.rows.length) return null;
    await useSigningKeys(ctx, session, conversation);
    const outcomes = session.engine.decrypt(conversation.id, stored.rows, stored.keyEvents);
    const people = new Map<string, Person>(conversation.participants.map((p) => [p.id.slice(2), p as Person]));
    people.set(session.meId, session.me);
    const messages = chatMessages(stored.rows, outcomes, { conversationId: conversation.id as ContractId, meId: session.meId, people }).filter(
      (m) => m.text !== UNDECRYPTABLE_TEXT,
    );
    if (!messages.length) return null;
    await ctx.runMutation(internal.ingest.upsertMessages, { accountId: session.accountId, messages });
    const { unavailable: _locked, ...rest } = conversation;
    const lastMessage = messages[0]!;
    await ctx.runMutation(internal.ingest.upsertConversations, {
      accountId: session.accountId,
      conversations: [{ ...rest, lastMessage, updatedAt: lastMessage.sentAt > rest.updatedAt ? lastMessage.sentAt : rest.updatedAt }],
    });
    return messages;
  } catch (err) {
    console.error("X Chat decrypt failed:", errorText(err));
    return null;
  }
}

// Signing keys for these X users, from the cache or, for misses, from X
// (GET /2/users/{id}/public_keys, budgeted as chat event reads).
async function signingKeysFor(ctx: ActionCtx, x: XChatConnection, meId: string, xUserIds: string[], maxAgeMs: number): Promise<ChatSigningKey[]> {
  const cached = await ctx.runQuery(internal.x.chatKeys.cachedPublicKeys, { xUserIds, maxAgeMs });
  const have = new Set(cached.map((c) => c.xUserId));
  const missing = xUserIds.filter((id) => !have.has(id));
  const keys = cached.flatMap((c) => c.keys);
  if (!missing.length) return keys;
  try {
    const context = await x.client.keyContext(x.session(), { meId, participantIds: missing.filter((id) => id !== meId) });
    await cacheSigningKeys(ctx, context.signingKeys, [meId, ...missing]);
    return [...keys, ...context.signingKeys];
  } finally {
    await x.saving();
  }
}

async function cacheSigningKeys(ctx: ActionCtx, keys: ChatSigningKey[], xUserIds: string[] = [...new Set(keys.map((k) => k.userId))]) {
  const entries = [...new Set(xUserIds)].map((xUserId) => ({ xUserId, keys: keys.filter((k) => k.userId === xUserId) }));
  if (entries.length) await ctx.runMutation(internal.x.chatKeys.cachePublicKeys, { entries });
}

function toInput(row: Doc<"conversations">): ConversationInput {
  const { _id, _creationTime, userId, lastMessage, updatedAt, ...rest } = row;
  return {
    ...rest,
    updatedAt: new Date(updatedAt).toISOString(),
    ...(lastMessage ? { lastMessage: { ...lastMessage, sentAt: new Date(lastMessage.sentAt).toISOString() } } : {}),
  };
}

function asLocked(conversation: ConversationInput): ConversationInput {
  const { lastMessage: _lastMessage, ...rest } = conversation;
  return { ...rest, unavailable: { reason: "locked" } };
}

function errorText(err: unknown): string {
  if (err instanceof ConnectorFailure) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

// AES-256-GCM with X_CHAT_KEY_ENCRYPTION_KEY (32 bytes, base64), the account
// id and X identity as additional data so a row can't be moved to another
// account. Stored as base64(iv || ciphertext).
async function encryptionKey(): Promise<CryptoKey> {
  const raw = process.env.X_CHAT_KEY_ENCRYPTION_KEY;
  const bytes = raw ? Buffer.from(raw, "base64") : null;
  if (!bytes || bytes.length !== 32) throw new Error("X_CHAT_KEY_ENCRYPTION_KEY must be 32 bytes, base64");
  return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function sealKeys(keys: Uint8Array, accountId: Id<"connectedAccounts">, xUserId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`${accountId}:${xUserId}`) },
    await encryptionKey(),
    keys as Uint8Array<ArrayBuffer>,
  );
  return Buffer.concat([iv, new Uint8Array(sealed)]).toString("base64");
}

async function openKeys(stored: string, accountId: Id<"connectedAccounts">, xUserId: string): Promise<Uint8Array> {
  const bytes = Buffer.from(stored, "base64");
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: new TextEncoder().encode(`${accountId}:${xUserId}`) },
    await encryptionKey(),
    bytes.subarray(12),
  );
  return new Uint8Array(opened);
}
