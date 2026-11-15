/// <reference types="vite/client" />
import { createHmac } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import samples from "../../src/connectors/x/fixtures/activity-events.json";
import { createFixtureFetch } from "../../src/connectors/x/mock";

const modules = import.meta.glob("/convex/**/*.ts");
const SECRET = "test-client-secret";
const ME = "2244994945";
const OTHER = "2222222222222222222";
const WEBHOOK_ID = "2090847910112202752";

const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("base64")}`;

// A doc sample addressed to our fixture user, with its own event id.
function sample(type: keyof typeof samples, eventId = crypto.randomUUID()) {
  const event = JSON.parse(JSON.stringify(samples[type]).replaceAll("1111111111111111111", ME));
  event.data.event_uuid = eventId;
  return event;
}

type Call = { method: string; path: string; auth?: string; body?: string };

function stubFetch(routes: Record<string, (call: Call) => Response> = {}) {
  const fixtureFetch = createFixtureFetch();
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      auth: (init?.headers as Record<string, string> | undefined)?.authorization,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`] ?? routes[`${call.method} ${call.path.replace(/\d+$/, ":id")}`];
    return route ? route(call) : fixtureFetch(input, init);
  }) as typeof fetch);
  return calls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A user with a synced, active X account, the webhook registered and the
// account subscribed.
async function setup() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const as = t.withIdentity({ subject: `${userId}|session` });
  const accountId = await as.mutation(api.accounts.connect, {
    session: { platform: "x", kind: "oauth", accessToken: "access", refreshToken: "refresh", expiresAt: "2099-01-01T00:00:00.000Z" },
  });
  stubFetch();
  await t.action(internal.x.sync.syncAccount, { accountId });
  await t.run(async (ctx) => {
    await ctx.db.insert("x_webhook", { webhookId: WEBHOOK_ID, url: "https://example.convex.site/x/webhook" });
    await ctx.db.insert("x_webhook_accounts", { accountId, xUserId: ME, subscriptionIds: ["s1", "s2"] });
  });
  const deliver = async (event: unknown, signature?: string) => {
    const body = JSON.stringify(event);
    const res = await t.fetch("/x/webhook", { method: "POST", body, headers: { "x-twitter-webhooks-signature-oauth2": signature ?? sign(body) } });
    await t.finishAllScheduledFunctions(() => {});
    return res;
  };
  const rows = <T extends "messages" | "conversations" | "posts" | "x_chat_events" | "x_webhook_events" | "x_webhook_accounts" | "x_usage">(table: T) =>
    t.run((ctx) => ctx.db.query(table).collect());
  return { t, accountId, deliver, rows };
}

beforeEach(() => {
  vi.stubEnv("X_CLIENT_ID", "test-client-id");
  vi.stubEnv("X_CLIENT_SECRET", SECRET);
  vi.stubEnv("X_BEARER_TOKEN", "app-bearer");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("/x/webhook", () => {
  test("answers the CRC with the HMAC of crc_token under the client secret", async () => {
    const { t } = await setup();
    const res = await t.fetch("/x/webhook?crc_token=challenge_string", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ response_token: sign("challenge_string") });
  });

  test("rejects a missing or wrong signature and stores nothing", async () => {
    const { deliver, rows } = await setup();
    const event = sample("dm.received");
    expect((await deliver(event, "sha256=bogus")).status).toBe(401);
    const body = JSON.stringify(event);
    expect((await deliver(event, sign(`${body} `))).status).toBe(401);
    expect(await rows("x_webhook_events")).toEqual([]);
    expect((await rows("messages")).filter((m) => m.text === "hello!")).toEqual([]);
  });

  test("dm.received stores the message and a named conversation, once", async () => {
    const { deliver, rows } = await setup();
    const event = sample("dm.received");
    expect((await deliver(event)).status).toBe(200);
    expect((await deliver(event)).status).toBe(200);
    const id = `x:${ME}-${OTHER}`;
    expect((await rows("messages")).filter((m) => m.conversationId === id)).toEqual([
      expect.objectContaining({ id: "x:2080765901528535096", text: "hello!", isMine: false, sentAt: 1784928224372 }),
    ]);
    expect((await rows("conversations")).find((c) => c.id === id)).toMatchObject({
      participants: [{ id: `x:${OTHER}`, handle: "OtherUser", displayName: "OtherUser" }],
      lastMessage: { text: "hello!" },
      updatedAt: 1784928224372,
    });
    expect((await rows("x_webhook_events")).length).toBe(1);
    expect((await rows("x_usage")).find((u) => u.key.includes(":webhookEvents:"))?.used).toBe(1);
  });

  test("a DM in a stored conversation moves its preview", async () => {
    const { deliver, rows } = await setup();
    const event = sample("dm.received");
    const dm = event.data.payload.direct_message_events[0];
    dm.message_create.sender_id = "1234567890";
    dm.created_timestamp = String(Date.parse("2099-01-01T00:00:00Z"));
    await deliver(event);
    const conversation = (await rows("conversations")).find((c) => c.id === `x:1234567890-${ME}`)!;
    expect(conversation).toMatchObject({ lastMessage: { text: "hello!" }, updatedAt: Date.parse("2099-01-01T00:00:00Z") });
    expect(conversation.participants[0]!.handle).not.toBe("");
  });

  test("chat.received stores ciphertext and a locked conversation", async () => {
    const { deliver, rows } = await setup();
    await deliver(sample("chat.received"));
    const events = await rows("x_chat_events");
    expect(events.map((e) => e.kind).sort()).toEqual(["event", "key"]);
    expect(events.find((e) => e.kind === "event")).toMatchObject({
      eventId: "2080400825227100160",
      sortKey: "2080400825227100160",
      conversationId: `x:${ME}-${OTHER}`,
      senderId: OTHER,
      keyVersion: "1768236281331",
    });
    expect((await rows("conversations")).find((c) => c.id === `x:${ME}-${OTHER}`)).toMatchObject({
      unavailable: { reason: "locked" },
      participants: [{ id: `x:${OTHER}` }],
      updatedAt: 1784841183370,
    });
  });

  test("an older DM delivered late doesn't move the preview back", async () => {
    const { deliver, rows } = await setup();
    const newer = sample("dm.received");
    const older = sample("dm.received");
    const dm = older.data.payload.direct_message_events[0];
    dm.id = "2080765901528535000";
    dm.created_timestamp = String(Number(dm.created_timestamp) - 60_000);
    dm.message_create.message_data.text = "earlier";
    await deliver(newer);
    await deliver(older);
    const conversation = (await rows("conversations")).find((c) => c.id === `x:${ME}-${OTHER}`)!;
    expect(conversation).toMatchObject({ lastMessage: { text: "hello!" }, updatedAt: 1784928224372 });
    expect((await rows("messages")).filter((m) => m.conversationId === conversation.id).length).toBe(2);
  });

  test("events for an X identity the account no longer holds are ignored", async () => {
    const { t, accountId, deliver, rows } = await setup();
    await t.run((ctx) => ctx.db.patch(accountId, { me: { id: "x:777", platform: "x", handle: "new", displayName: "New" } }));
    await deliver(sample("dm.received"));
    await deliver(sample("oauth.revoke"));
    expect((await rows("messages")).filter((m) => m.text === "hello!")).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(accountId))).toMatchObject({ status: "active" });
  });

  test("post.mention.create stores the post", async () => {
    const { deliver, rows } = await setup();
    await deliver(sample("post.mention.create"));
    expect((await rows("posts")).find((p) => p.id === "x:2080765813578191303")).toMatchObject({
      text: "hey @ExampleUser",
      author: { handle: "OtherUser" },
    });
  });

  test("ignores events for X users without a subscribed account", async () => {
    const { deliver, rows } = await setup();
    const event = sample("dm.received");
    event.data.filter.user_id = "999";
    expect((await deliver(event)).status).toBe(200);
    expect((await rows("messages")).filter((m) => m.text === "hello!")).toEqual([]);
  });

  test("past the daily cap the subscriptions are removed until the next UTC day", async () => {
    vi.stubEnv("X_DAILY_WEBHOOK_EVENT_CAP", "1");
    const { deliver, rows } = await setup();
    const calls = stubFetch({ "DELETE /2/activity/subscriptions/:id": () => json({ data: { deleted: true } }) });
    await deliver(sample("dm.received"));
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([
      expect.objectContaining({ path: "/2/activity/subscriptions/s1", auth: "Bearer app-bearer" }),
      expect.objectContaining({ path: "/2/activity/subscriptions/s2", auth: "Bearer app-bearer" }),
    ]);
    const [row] = await rows("x_webhook_accounts");
    expect(row).toMatchObject({ subscriptionIds: [] });
    expect(row!.pausedUntil).toBe(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1));
    expect((await rows("messages")).filter((m) => m.text === "hello!").length).toBe(1);
  });

  test("oauth.revoke expires the account and forgets its subscriptions", async () => {
    const { t, accountId, deliver, rows } = await setup();
    await deliver(sample("oauth.revoke"));
    expect(await t.run((ctx) => ctx.db.get(accountId))).toMatchObject({ status: "expired", lastError: { kind: "session_expired" } });
    expect(await rows("x_webhook_accounts")).toEqual([]);
  });
});

describe("subscriptions", () => {
  test("subscribe creates the missing ones and replaces one on another webhook", async () => {
    const { t, accountId, rows } = await setup();
    let next = 100;
    const calls = stubFetch({
      "GET /2/activity/subscriptions": () =>
        json({
          data: [
            { subscription_id: "11", event_type: "dm.received", webhook_id: WEBHOOK_ID },
            { subscription_id: "12", event_type: "chat.sent", webhook_id: "1" },
          ],
        }),
      "POST /2/activity/subscriptions": () => json({ data: { subscription: { subscription_id: String(next++) } } }),
      "DELETE /2/activity/subscriptions/:id": () => json({ data: { deleted: true } }),
    });
    await t.action(internal.x.webhook.subscribe, { accountId });
    const created = calls.filter((c) => c.method === "POST" && c.path === "/2/activity/subscriptions").map((c) => JSON.parse(c.body!));
    expect(created.map((b) => b.event_type)).toEqual(["dm.sent", "chat.received", "chat.sent", "post.mention.create"]);
    expect(created[0]).toEqual({ event_type: "dm.sent", filter: { user_id: ME }, webhook_id: WEBHOOK_ID, tag: "fomovoider" });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/2/activity/subscriptions/12"]);
    expect(calls.every((c) => c.path.startsWith("/2/oauth2") || c.auth === "Bearer access")).toBe(true);
    expect((await rows("x_webhook_accounts"))[0]).toMatchObject({ xUserId: ME, subscriptionIds: ["11", "100", "101", "102", "103"] });
  });

  test("ensureAll retries a pause whose deletions failed", async () => {
    const { t, accountId, rows } = await setup();
    const until = Date.now() + 60 * 60 * 1000;
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("x_webhook_accounts").collect())[0]!;
      await ctx.db.patch(row._id, { pausedUntil: until });
    });
    const calls = stubFetch({ "DELETE /2/activity/subscriptions/:id": () => json({ data: { deleted: true } }) });
    await t.mutation(internal.x.webhook.ensureAll, {});
    await t.finishAllScheduledFunctions(() => {});
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/2/activity/subscriptions/s1", "/2/activity/subscriptions/s2"]);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect((await rows("x_webhook_accounts"))[0]).toMatchObject({ accountId, subscriptionIds: [], pausedUntil: until });
  });

  test("dropping an account keeps subscriptions another account of the same X user uses", async () => {
    const { t, accountId, rows } = await setup();
    const otherAccount = await t.run(async (ctx) => {
      const account = (await ctx.db.get(accountId))!;
      const userId = await ctx.db.insert("users", {});
      const { _id, _creationTime, ...rest } = account;
      const id = await ctx.db.insert("connectedAccounts", { ...rest, userId });
      await ctx.db.insert("x_webhook_accounts", { accountId: id, xUserId: ME, subscriptionIds: ["s1", "s2"] });
      await ctx.db.delete(accountId);
      return id;
    });
    const calls = stubFetch({
      "GET /2/activity/subscriptions": () => json({ data: [] }),
      "POST /2/activity/subscriptions": () => json({ data: { subscription: { subscription_id: "7" } } }),
    });
    await t.mutation(internal.x.webhook.ensureAll, {});
    await t.finishAllScheduledFunctions(() => {});
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect((await rows("x_webhook_accounts")).map((r) => r.accountId)).toEqual([otherAccount]);
  });

  test("ensureAll subscribes new accounts, resumes paused ones and drops gone ones", async () => {
    const { t, accountId, rows } = await setup();
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const goneId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("connectedAccounts", {
        userId,
        platform: "x",
        session: { platform: "x", kind: "oauth", accessToken: "a" },
        status: "expired",
        me: { id: "x:42", platform: "x", handle: "gone", displayName: "Gone" },
      });
      await ctx.db.insert("x_webhook_accounts", { accountId: id, xUserId: "42", subscriptionIds: ["s9"] });
      const row = (await ctx.db.query("x_webhook_accounts").collect()).find((r) => r.accountId === accountId)!;
      await ctx.db.patch(row._id, { subscriptionIds: [], pausedUntil: Date.now() - 1 });
      return id;
    });
    const calls = stubFetch({
      "GET /2/activity/subscriptions": () => json({ data: [] }),
      "POST /2/activity/subscriptions": () => json({ data: { subscription: { subscription_id: "7" } } }),
      "DELETE /2/activity/subscriptions/:id": () => json({}, 404),
    });
    await t.mutation(internal.x.webhook.ensureAll, {});
    await t.finishAllScheduledFunctions(() => {});
    expect(calls.find((c) => c.method === "DELETE")).toMatchObject({ path: "/2/activity/subscriptions/s9", auth: "Bearer app-bearer" });
    const left = await rows("x_webhook_accounts");
    expect(left.map((r) => r.accountId)).toEqual([accountId]);
    expect(left[0]).toMatchObject({ subscriptionIds: ["7", "7", "7", "7", "7"] });
    expect(left[0]!.pausedUntil).toBeUndefined();
    expect(left.some((r) => r.accountId === goneId)).toBe(false);
  });
});
