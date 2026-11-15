import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { type MutationCtx, httpAction, internalAction, internalMutation, internalQuery } from "../_generated/server";
import { eventSortKey } from "../../src/connectors/x/chat";
import {
  type ActivityEvent,
  BILLED_EVENTS,
  WEBHOOK_EVENTS,
  activityUserId,
  chatActivity,
  deleteSubscriptions,
  dmActivity,
  mentionActivity,
  parseActivity,
  registerWebhook,
  signWebhook,
  verifyWebhook,
} from "../../src/connectors/x/activity";
import { withX } from "./send";

// Real-time X: the X Activity API delivers DMs, X Chat events and mentions to
// /x/webhook. Polling (sync.ts, chat.ts) stays as the backstop. See
// convex/x/README.md, "Webhooks".

const DEFAULT_DAILY_EVENT_CAP = 200;
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 500;
const TAG = "fomovoider";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// GET answers X's CRC; POST takes signed events. Events are stored by
// scheduled functions, so X gets its 200 right away.
export const handle = httpAction(async (ctx, request) => {
  const secret = process.env.X_CLIENT_SECRET;
  if (!secret) return new Response("X_CLIENT_SECRET is not set", { status: 500 });
  if (request.method === "GET") {
    const token = new URL(request.url).searchParams.get("crc_token");
    if (!token) return new Response("Missing crc_token", { status: 400 });
    return json({ response_token: await signWebhook(secret, token) });
  }
  const body = await request.arrayBuffer();
  if (!(await verifyWebhook(secret, body, request.headers.get("x-twitter-webhooks-signature-oauth2")))) {
    return new Response("Invalid signature", { status: 401 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const events = parseActivity(parsed);
  if (events.length) await ctx.runMutation(internal.x.webhook.accept, { events });
  return new Response(null, { status: 200 });
});

// Drops redeliveries, routes each event to the accounts of its X user, counts
// billed events against the daily cap, and schedules the work.
export const accept = internalMutation({
  args: { events: v.array(v.any()) },
  returns: v.null(),
  handler: async (ctx, { events }) => {
    const cap = dailyEventCap();
    for (const event of events as ActivityEvent[]) {
      const seen = await ctx.db.query("x_webhook_events").withIndex("by_eventId", (q) => q.eq("eventId", event.event_uuid)).first();
      if (seen) continue;
      await ctx.db.insert("x_webhook_events", { eventId: event.event_uuid, receivedAt: Date.now() });
      const xUserId = activityUserId(event);
      if (!xUserId) continue;
      const rows = await ctx.db.query("x_webhook_accounts").withIndex("by_xUserId", (q) => q.eq("xUserId", xUserId)).collect();
      if (event.event_type === "oauth.revoke") {
        for (const row of rows) {
          const account = await ctx.db.get(row.accountId);
          if (account) await ctx.db.patch(account._id, { status: "expired", lastError: { kind: "session_expired" } });
          await ctx.db.delete(row._id);
        }
        continue;
      }
      const active: Doc<"x_webhook_accounts">[] = [];
      for (const row of rows) if ((await ctx.db.get(row.accountId))?.status === "active") active.push(row);
      if (!active.length) continue;
      const used = BILLED_EVENTS.has(event.event_type) ? await countEvent(ctx, xUserId) : 0;
      for (const row of active) {
        if (used >= cap && row.pausedUntil === undefined) {
          await ctx.db.patch(row._id, { pausedUntil: nextUtcDay() });
          await ctx.scheduler.runAfter(0, internal.x.webhook.pause, { accountId: row.accountId });
        }
        await ctx.scheduler.runAfter(0, internal.x.webhook.processEvent, { accountId: row.accountId, event });
      }
    }
    return null;
  },
});

// Stores one event through the shared ingest functions.
export const processEvent = internalAction({
  args: { accountId: v.id("connectedAccounts"), event: v.any() },
  returns: v.null(),
  handler: async (ctx, { accountId, event: raw }) => {
    const event = raw as ActivityEvent;
    const account = await ctx.runQuery(internal.accounts.get, { accountId });
    if (!account?.me || account.status !== "active") return null;
    const meId = account.me.id.slice(2);
    switch (event.event_type) {
      case "dm.received":
      case "dm.sent":
        for (const { message, conversation } of dmActivity(event.payload, meId)) {
          const { raw: _raw, ...stored } = message;
          await ctx.runMutation(internal.ingest.upsertMessages, { accountId, messages: [stored] });
          const shown = await ctx.runMutation(internal.x.state.showMessage, { accountId, message: { ...stored, sentAt: Date.parse(stored.sentAt) } });
          if (!shown) await ctx.runMutation(internal.ingest.upsertConversations, { accountId, conversations: [{ ...conversation, lastMessage: stored }] });
        }
        return null;
      case "chat.received":
      case "chat.sent": {
        const chat = chatActivity(event.payload, meId);
        const keys = chat.keyEvent ? [{ eventId: `key:${await sha256(chat.keyEvent)}`, encodedEvent: chat.keyEvent }] : [];
        const participants = await ctx.runMutation(internal.x.webhook.storeChat, { accountId, conversationId: chat.conversation.id, updatedAt: chat.conversation.updatedAt, event: chat.event, keys });
        if (participants) {
          await ctx.runMutation(internal.ingest.upsertConversations, {
            accountId,
            conversations: [{ ...chat.conversation, participants: participants.length ? participants : chat.conversation.participants }],
          });
        }
        return null;
      }
      case "post.mention.create":
        await ctx.runMutation(internal.ingest.upsertPosts, { accountId, posts: [mentionActivity(event)] });
        return null;
      default:
        return null;
    }
  },
});

// Stores a delivered X Chat event as ciphertext. Returns the participants to
// keep when the inbox row must become (or stay) a locked X Chat row, or null
// when a newer row already covers the conversation.
export const storeChat = internalMutation({
  args: {
    accountId: v.id("connectedAccounts"),
    conversationId: v.string(),
    updatedAt: v.string(),
    event: v.object({ id: v.string(), encodedEvent: v.string(), keyVersion: v.optional(v.string()), senderId: v.optional(v.string()), createdAt: v.optional(v.string()) }),
    keys: v.array(v.object({ eventId: v.string(), encodedEvent: v.string() })),
  },
  returns: v.union(v.null(), v.array(v.any())),
  handler: async (ctx, { accountId, conversationId, updatedAt, event, keys }) => {
    const account = await ctx.db.get(accountId);
    if (!account?.me) return null;
    const { userId } = account;
    const xUserId = account.me.id;
    const { id, ...rest } = event;
    const rows = [
      { kind: "event" as const, eventId: id, sortKey: eventSortKey(id), ...rest },
      ...keys.map((k) => ({ kind: "key" as const, eventId: k.eventId, sortKey: "", encodedEvent: k.encodedEvent })),
    ];
    for (const row of rows) {
      const existing = await ctx.db.query("x_chat_events").withIndex("by_userId_and_eventId", (q) => q.eq("userId", userId).eq("eventId", row.eventId)).first();
      if (!existing) await ctx.db.insert("x_chat_events", { userId, xUserId, conversationId, ...row });
    }
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", conversationId))
      .unique();
    if (conversation && conversation.updatedAt >= Date.parse(updatedAt)) return null;
    return conversation?.participants ?? [];
  },
});

// Creates or refreshes an account's subscriptions on the registered webhook.
export const subscribe = internalAction({
  args: { accountId: v.id("connectedAccounts") },
  returns: v.null(),
  handler: async (ctx, { accountId }) => {
    const webhook = await ctx.runQuery(internal.x.webhook.config, {});
    const account = await ctx.runQuery(internal.accounts.get, { accountId });
    if (!webhook || !account?.me || account.status !== "active") return null;
    const subscriptionIds = await withX(ctx, account, (x, session) =>
      x.subscribeActivity(session, { webhookId: webhook.webhookId, eventTypes: WEBHOOK_EVENTS, tag: TAG }),
    );
    await ctx.runMutation(internal.x.webhook.saveSubscriptions, { accountId, xUserId: account.me.id.slice(2), subscriptionIds });
    return null;
  },
});

// The daily cap was reached: the account's subscriptions are removed until
// pausedUntil (the next UTC day), and polling covers the rest of the day.
export const pause = internalAction({
  args: { accountId: v.id("connectedAccounts") },
  returns: v.null(),
  handler: async (ctx, { accountId }) => {
    const row = await ctx.runQuery(internal.x.webhook.subscriptions, { accountId });
    if (!row?.subscriptionIds.length) return null;
    await deleteSubscriptions({ bearerToken: bearerToken(), ids: row.subscriptionIds });
    await ctx.runMutation(internal.x.webhook.saveSubscriptions, { accountId, xUserId: row.xUserId, subscriptionIds: [], pausedUntil: row.pausedUntil });
    return null;
  },
});

// Removes the subscriptions of an account that is gone or no longer active
// (its user token may be unusable, so the app token is used).
export const drop = internalAction({
  args: { rowId: v.id("x_webhook_accounts"), subscriptionIds: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { rowId, subscriptionIds }) => {
    if (subscriptionIds.length) await deleteSubscriptions({ bearerToken: bearerToken(), ids: subscriptionIds });
    await ctx.runMutation(internal.x.webhook.deleteRow, { rowId });
    return null;
  },
});

// Hourly (crons.ts): subscribes active accounts that aren't yet, resumes
// accounts whose pause ended, drops subscriptions of accounts that went
// away, and prunes old event ids.
export const ensureAll = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    if (await ctx.db.query("x_webhook").first()) {
      const accounts = await ctx.db.query("connectedAccounts").withIndex("by_platform", (q) => q.eq("platform", "x")).collect();
      for (const account of accounts) {
        if (account.status !== "active" || !account.me) continue;
        const row = await ctx.db.query("x_webhook_accounts").withIndex("by_accountId", (q) => q.eq("accountId", account._id)).unique();
        if (!row || (row.pausedUntil !== undefined && row.pausedUntil <= now)) {
          await ctx.scheduler.runAfter(0, internal.x.webhook.subscribe, { accountId: account._id });
        }
      }
    }
    for (const row of await ctx.db.query("x_webhook_accounts").collect()) {
      const account = await ctx.db.get(row.accountId);
      if (account?.status === "active" && account.me?.id === `x:${row.xUserId}`) continue;
      await ctx.scheduler.runAfter(0, internal.x.webhook.drop, { rowId: row._id, subscriptionIds: row.subscriptionIds });
    }
    const old = await ctx.db
      .query("x_webhook_events")
      .withIndex("by_receivedAt", (q) => q.lt("receivedAt", now - EVENT_RETENTION_MS))
      .take(PRUNE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    return null;
  },
});

// Run once per deployment, after deploying: registers
// ${CONVEX_SITE_URL}/x/webhook with X (X runs a CRC against it) and
// subscribes every active account.
export const register = internalAction({
  args: { url: v.optional(v.string()) },
  returns: v.object({ webhookId: v.string(), url: v.string(), valid: v.boolean() }),
  handler: async (ctx, args) => {
    const url = args.url ?? `${process.env.CONVEX_SITE_URL}/x/webhook`;
    const webhook = await registerWebhook({ bearerToken: bearerToken(), url });
    await ctx.runMutation(internal.x.webhook.saveWebhook, { webhookId: webhook.id, url });
    await ctx.runMutation(internal.x.webhook.ensureAll, {});
    return { webhookId: webhook.id, url, valid: webhook.valid };
  },
});

export const config = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("x_webhook").first(),
});

export const subscriptions = internalQuery({
  args: { accountId: v.id("connectedAccounts") },
  handler: async (ctx, { accountId }) =>
    await ctx.db.query("x_webhook_accounts").withIndex("by_accountId", (q) => q.eq("accountId", accountId)).unique(),
});

// A new webhook id invalidates every stored subscription; ensureAll then
// subscribes the accounts again.
export const saveWebhook = internalMutation({
  args: { webhookId: v.string(), url: v.string() },
  returns: v.null(),
  handler: async (ctx, { webhookId, url }) => {
    const existing = await ctx.db.query("x_webhook").first();
    if (existing?.webhookId === webhookId && existing.url === url) return null;
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("x_webhook", { webhookId, url });
    for (const row of await ctx.db.query("x_webhook_accounts").collect()) await ctx.db.delete(row._id);
    return null;
  },
});

export const saveSubscriptions = internalMutation({
  args: { accountId: v.id("connectedAccounts"), xUserId: v.string(), subscriptionIds: v.array(v.string()), pausedUntil: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { accountId, xUserId, subscriptionIds, pausedUntil }) => {
    const row = await ctx.db.query("x_webhook_accounts").withIndex("by_accountId", (q) => q.eq("accountId", accountId)).unique();
    const next = { accountId, xUserId, subscriptionIds, pausedUntil };
    if (row) await ctx.db.replace(row._id, next);
    else await ctx.db.insert("x_webhook_accounts", next);
    return null;
  },
});

export const deleteRow = internalMutation({
  args: { rowId: v.id("x_webhook_accounts") },
  returns: v.null(),
  handler: async (ctx, { rowId }) => {
    if (await ctx.db.get(rowId)) await ctx.db.delete(rowId);
    return null;
  },
});

// Billed events today for one X user, this one included (in x_usage).
async function countEvent(ctx: MutationCtx, xUserId: string): Promise<number> {
  const key = `x:${xUserId}:webhookEvents:${new Date().toISOString().slice(0, 10)}`;
  const row = await ctx.db.query("x_usage").withIndex("by_key", (q) => q.eq("key", key)).unique();
  const used = (row?.used ?? 0) + 1;
  if (row) await ctx.db.patch(row._id, { used });
  else await ctx.db.insert("x_usage", { key, used });
  return used;
}

function dailyEventCap(): number {
  const value = process.env.X_DAILY_WEBHOOK_EVENT_CAP;
  if (value === undefined || value === "") return DEFAULT_DAILY_EVENT_CAP;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error("X_DAILY_WEBHOOK_EVENT_CAP must be a non-negative integer");
  return parsed;
}

function nextUtcDay(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function bearerToken(): string {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) throw new Error("X_BEARER_TOKEN is not set");
  return token;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
