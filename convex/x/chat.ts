import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { type ActionCtx, action, internalAction, internalMutation, internalQuery, query } from "../_generated/server";
import { requireUserId } from "../lib/auth";
import { ConnectorFailure, type Session } from "../../src/connectors/types";
import { xConfigFromEnv } from "../../src/connectors/x/config";
import { type ChatEventRow, type ChatKeyContext, XChatClient, eventSortKey } from "../../src/connectors/x/chat";
import { convexUsageStore } from "./sync";

// X Chat (encrypted DMs). Convex lists conversations and moves ciphertext;
// the device decrypts with the user's passcode, which never reaches Convex.
// See convex/x/README.md, "X Chat".

// Per cron run: conversations listed. Per app request: events fetched for one
// conversation. Both also stop at the daily chatEventReads budget.
export const CHAT_LIST_LIMIT = 20;
export const EVENTS_PER_FETCH = 10;
const EVENTS_RETURNED = 200;
const PURGE_BATCH = 200;

const vSendPayload = v.object({
  messageId: v.string(),
  encodedMessageCreateEvent: v.string(),
  encodedMessageEventSignature: v.string(),
  xdkVersion: v.optional(v.string()),
});

export const syncAll = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const accounts = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_platform", (q) => q.eq("platform", "x"))
      .collect();
    for (const account of accounts) {
      if (account.status !== "active" || !account.me) continue;
      await ctx.scheduler.runAfter(0, internal.x.chat.syncAccount, { accountId: account._id });
    }
    await ctx.scheduler.runAfter(0, internal.x.chat.purgeOrphans, {});
    return null;
  },
});

// Lists X Chat conversations active since the last run and writes them to
// the shared inbox as locked rows, unless a newer legacy DM row covers them.
export const syncAccount = internalAction({
  args: { accountId: v.id("connectedAccounts") },
  returns: v.null(),
  handler: async (ctx, { accountId }) => {
    const loaded = await ctx.runQuery(internal.x.state.load, { accountId });
    const account = loaded?.account;
    if (!account || account.platform !== "x" || account.status !== "active" || !account.me) return null;
    const meId = account.me.id.slice(2);
    const x = connect(ctx, account);
    try {
      const res = await x.client.conversations(x.session(), { meId, since: loaded.state?.chatSince, limit: CHAT_LIST_LIMIT });
      const stale = new Set(
        await ctx.runQuery(internal.x.chat.staleConversations, {
          userId: account.userId,
          conversations: res.conversations.map(({ id, updatedAt }) => ({ id, updatedAt })),
        }),
      );
      const conversations = res.conversations.filter((c) => stale.has(c.id));
      if (conversations.length) await ctx.runMutation(internal.ingest.upsertConversations, { accountId, conversations });
      if (res.newestAt) await ctx.runMutation(internal.x.state.saveState, { accountId, xUserId: account.me.id, patch: { chatSince: res.newestAt } });
      await x.saving();
    } catch (err) {
      await x.saving().catch(() => undefined);
      if (err instanceof ConnectorFailure && err.error.kind === "budget_exhausted") return null;
      if (err instanceof ConnectorFailure && err.error.kind === "session_expired") {
        await ctx.runMutation(internal.accounts.recordSync, { accountId, error: err.error });
        return null;
      }
      console.error("X Chat sync failed:", err instanceof Error ? err.message : String(err));
    }
    return null;
  },
});

// Ids that are new, or newer than the stored row. A legacy DM row with the
// same or a later time already shows that conversation in plaintext.
export const staleConversations = internalQuery({
  args: { userId: v.id("users"), conversations: v.array(v.object({ id: v.string(), updatedAt: v.string() })) },
  returns: v.array(v.string()),
  handler: async (ctx, { userId, conversations }) => {
    const stale: string[] = [];
    for (const { id, updatedAt } of conversations) {
      const existing = await ctx.db
        .query("conversations")
        .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", id))
        .unique();
      if (!existing || existing.unavailable || existing.updatedAt < new Date(updatedAt).toISOString()) stale.push(id);
    }
    return stale;
  },
});

// For the device: pulls new encrypted events of one conversation from X into
// x_chat_events. The events query then delivers them reactively.
export const fetchEvents = action({
  args: { conversationId: v.string(), limit: v.optional(v.number()) },
  returns: v.object({ fetched: v.number(), caughtUp: v.boolean() }),
  handler: async (ctx, { conversationId, limit }): Promise<{ fetched: number; caughtUp: boolean }> => {
    const { account, meId, x } = await forUser(ctx, conversationId);
    const afterId: string | null = await ctx.runQuery(internal.x.chat.newestEventId, { userId: account.userId, xUserId: account.me!.id, conversationId });
    try {
      const res = await x.client.events(x.session(), conversationId as `x:${string}`, {
        meId,
        afterId: afterId ?? undefined,
        limit: Math.max(1, Math.min(limit ?? EVENTS_PER_FETCH, EVENTS_PER_FETCH)),
      });
      const keys = await Promise.all(res.keyEvents.map(async (encodedEvent) => ({ eventId: `key:${await sha256(encodedEvent)}`, encodedEvent })));
      await ctx.runMutation(internal.x.chat.storeEvents, {
        userId: account.userId,
        xUserId: account.me!.id,
        conversationId,
        events: res.events,
        keys,
      });
      return { fetched: res.events.length, caughtUp: res.caughtUp };
    } finally {
      await x.saving();
    }
  },
});

export const newestEventId = internalQuery({
  args: { userId: v.id("users"), xUserId: v.string(), conversationId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { userId, xUserId, conversationId }) => {
    const newest = await ctx.db
      .query("x_chat_events")
      .withIndex("by_userId_and_conversationId_and_kind_and_sortKey", (q) =>
        q.eq("userId", userId).eq("conversationId", conversationId).eq("kind", "event"),
      )
      .order("desc")
      .filter((q) => q.eq(q.field("xUserId"), xUserId))
      .first();
    return newest?.eventId ?? null;
  },
});

export const storeEvents = internalMutation({
  args: {
    userId: v.id("users"),
    xUserId: v.string(),
    conversationId: v.string(),
    events: v.array(
      v.object({
        id: v.string(),
        encodedEvent: v.string(),
        keyVersion: v.optional(v.string()),
        senderId: v.optional(v.string()),
        createdAt: v.optional(v.string()),
      }),
    ),
    keys: v.array(v.object({ eventId: v.string(), encodedEvent: v.string() })),
  },
  returns: v.null(),
  handler: async (ctx, { userId, xUserId, conversationId, events, keys }) => {
    const rows = [
      ...events.map(({ id, ...rest }) => ({ kind: "event" as const, eventId: id, sortKey: eventSortKey(id), ...rest })),
      ...keys.map(({ eventId, encodedEvent }) => ({ kind: "key" as const, eventId, sortKey: "", encodedEvent })),
    ];
    for (const row of rows) {
      const existing = await ctx.db
        .query("x_chat_events")
        .withIndex("by_userId_and_eventId", (q) => q.eq("userId", userId).eq("eventId", row.eventId))
        .first();
      if (!existing) await ctx.db.insert("x_chat_events", { userId, xUserId, conversationId, ...row });
    }
    return null;
  },
});

// For the device: the stored ciphertext of one conversation, newest first,
// with its key changes.
export const events = query({
  args: { conversationId: v.string() },
  handler: async (ctx, { conversationId }): Promise<{ rows: ChatEventRow[]; keyEvents: string[] } | null> => {
    const userId = await requireUserId(ctx);
    const account = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId).eq("platform", "x"))
      .unique();
    if (!account?.me) return null;
    const xUserId = account.me.id;
    const byKind = (kind: "event" | "key") =>
      ctx.db
        .query("x_chat_events")
        .withIndex("by_userId_and_conversationId_and_kind_and_sortKey", (q) =>
          q.eq("userId", userId).eq("conversationId", conversationId).eq("kind", kind),
        )
        .order("desc")
        .filter((q) => q.eq(q.field("xUserId"), xUserId))
        .take(EVENTS_RETURNED);
    const [rows, keys] = await Promise.all([byKind("event"), byKind("key")]);
    return {
      rows: rows.map((r) => ({
        id: r.eventId,
        encodedEvent: r.encodedEvent,
        ...(r.keyVersion ? { keyVersion: r.keyVersion } : {}),
        ...(r.senderId ? { senderId: r.senderId } : {}),
        ...(r.createdAt ? { createdAt: r.createdAt } : {}),
      })),
      keyEvents: keys.map((k) => k.encodedEvent),
    };
  },
});

// For the device, at unlock and when opening a chat: the account's key
// record with its Juicebox config, and the participants' public keys.
export const keyContext = action({
  args: { conversationId: v.optional(v.string()) },
  handler: async (ctx, { conversationId }): Promise<ChatKeyContext> => {
    const { meId, x, participantIds } = await forUser(ctx, conversationId);
    try {
      return await x.client.keyContext(x.session(), { meId, participantIds });
    } finally {
      await x.saving();
    }
  },
});

// For the device: posts a message it already encrypted and signed.
export const send = action({
  args: { conversationId: v.string(), payload: vSendPayload },
  returns: v.null(),
  handler: async (ctx, { conversationId, payload }) => {
    const { meId, x } = await forUser(ctx, conversationId);
    try {
      await x.client.send(x.session(), conversationId as `x:${string}`, { meId, payload });
    } finally {
      await x.saving();
    }
    return null;
  },
});

export const accountFor = internalQuery({
  args: { userId: v.id("users"), conversationId: v.optional(v.string()) },
  handler: async (ctx, { userId, conversationId }): Promise<{ account: Doc<"connectedAccounts"> | null; participantIds: string[] }> => {
    const account = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId).eq("platform", "x"))
      .unique();
    if (!conversationId) return { account, participantIds: [] };
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", conversationId))
      .unique();
    if (!conversation) throw new Error("Conversation not found");
    return { account, participantIds: conversation.participants.map((p) => p.id.slice(2)) };
  },
});

// Deletes stored ciphertext whose X account is gone or now belongs to another
// X identity, a batch at a time.
export const purgeOrphans = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("x_chat_events").paginate({ numItems: PURGE_BATCH, cursor: cursor ?? null });
    const owners = new Map<Id<"users">, string | null>();
    for (const row of page.page) {
      if (!owners.has(row.userId)) {
        const account = await ctx.db
          .query("connectedAccounts")
          .withIndex("by_userId_and_platform", (q) => q.eq("userId", row.userId).eq("platform", "x"))
          .unique();
        owners.set(row.userId, account?.me?.id ?? null);
      }
      if (owners.get(row.userId) !== row.xUserId) await ctx.db.delete(row._id);
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.x.chat.purgeOrphans, { cursor: page.continueCursor });
    return null;
  },
});

type Connection = ReturnType<typeof connect>;

async function forUser(
  ctx: ActionCtx,
  conversationId: string | undefined,
): Promise<{ account: Doc<"connectedAccounts">; meId: string; participantIds: string[]; x: Connection }> {
  const userId = await requireUserId(ctx);
  const { account, participantIds }: { account: Doc<"connectedAccounts"> | null; participantIds: string[] } = await ctx.runQuery(
    internal.x.chat.accountFor,
    { userId, conversationId },
  );
  if (!account?.me || account.status !== "active" || account.session.kind !== "oauth") {
    throw new ConnectorFailure({ kind: "session_expired" }, "Connect X first");
  }
  return { account, meId: account.me.id.slice(2), participantIds, x: connect(ctx, account) };
}

function connect(ctx: ActionCtx, account: Doc<"connectedAccounts">) {
  let session = account.session as Session;
  let saving: Promise<unknown> = Promise.resolve();
  const client = new XChatClient({
    config: xConfigFromEnv(process.env),
    usage: convexUsageStore(ctx),
    onSessionRefreshed: (next) => {
      session = next;
      saving = saving.then(() =>
        ctx.runMutation(internal.accounts.saveSession, { accountId: account._id, session: next as Doc<"connectedAccounts">["session"] }),
      );
    },
  });
  return { client, session: () => session, saving: () => saving };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
