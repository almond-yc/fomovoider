/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import conversationsFixture from "../../src/connectors/x/chat/fixtures/chat-conversations.json";
import eventsFixture from "../../src/connectors/x/chat/fixtures/chat-events.json";
import keysMe from "../../src/connectors/x/chat/fixtures/chat-public-keys-me.json";
import keysAlice from "../../src/connectors/x/chat/fixtures/chat-public-keys-alice.json";
import sendFixture from "../../src/connectors/x/chat/fixtures/chat-send.json";

const modules = import.meta.glob("/convex/**/*.ts");
const ME = "2244994945";
const ALICE = "1234567890";
const ONE_TO_ONE = `x:${ALICE}-${ME}`;
const GROUP = "x:g1987000000000000000";
const me = { id: `x:${ME}`, platform: "x", handle: "me", displayName: "Me" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubX(routes: Record<string, (url: URL, init?: RequestInit) => Response>) {
  const calls: { path: string; url: URL; body?: string }[] = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, url, body: init?.body ? String(init.body) : undefined });
    const route = routes[`${init?.method ?? "GET"} ${url.pathname}`];
    if (!route) throw new Error(`Unmocked request: ${url.pathname}`);
    return route(url, init);
  }) as typeof fetch);
  return calls;
}

const defaultRoutes = {
  "GET /2/chat/conversations": () => json(structuredClone(conversationsFixture)),
  [`GET /2/chat/conversations/${ALICE}/events`]: (url: URL) =>
    json(url.searchParams.get("pagination_token") ? { data: [], meta: { has_more: false, result_count: 0 } } : structuredClone(eventsFixture)),
  [`GET /2/users/${ME}/public_keys`]: () => json(structuredClone(keysMe)),
  [`GET /2/users/${ALICE}/public_keys`]: () => json(structuredClone(keysAlice)),
  [`POST /2/chat/conversations/${ALICE}/messages`]: () => json(structuredClone(sendFixture), 201),
};

async function setup() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const as = t.withIdentity({ subject: `${userId}|session` });
  const accountId = await as.mutation(api.accounts.connect, {
    session: { platform: "x", kind: "oauth", accessToken: "access", refreshToken: "refresh", expiresAt: "2099-01-01T00:00:00.000Z" },
  });
  await t.mutation(internal.accounts.verifyIdentity, { accountId, me });
  const rows = () => t.run((ctx) => ctx.db.query("x_chat_events").collect());
  const conversations = () => t.run((ctx) => ctx.db.query("conversations").collect());
  return { t, userId, accountId, as, rows, conversations };
}

beforeEach(() => {
  vi.stubEnv("X_CLIENT_ID", "test-client-id");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("x chat sync", () => {
  test("writes X Chat conversations as locked inbox rows and remembers where it got to", async () => {
    const calls = stubX(defaultRoutes);
    const { t, accountId, conversations } = await setup();
    await t.action(internal.x.chat.syncAccount, { accountId });

    const rows = await conversations();
    expect(rows.map((c) => [c.id, c.unavailable?.reason, c.lastMessage])).toEqual([
      [ONE_TO_ONE, "locked", undefined],
      [GROUP, "locked", undefined],
    ]);
    const state = await t.run((ctx) => ctx.db.query("x_sync_state").first());
    expect(state?.chatSince).toBe("2026-11-15T18:30:00.000Z");

    await t.action(internal.x.chat.syncAccount, { accountId });
    expect(calls.filter((c) => c.path === "/2/chat/conversations").at(-1)!.url.searchParams.get("start_time")).toBe("2026-11-15T18:30:00.000Z");
  });

  test("leaves a legacy DM row alone when it is as new as the X Chat one", async () => {
    stubX(defaultRoutes);
    const { t, accountId, conversations } = await setup();
    const legacy = {
      id: ONE_TO_ONE,
      platform: "x",
      participants: [{ id: `x:${ALICE}`, platform: "x", handle: "alice", displayName: "Alice" }],
      lastMessage: { id: "x:1", conversationId: ONE_TO_ONE, sender: me, isMine: true, sentAt: "2026-11-15T18:30:00.000Z", text: "plain legacy DM", media: [] },
      updatedAt: "2026-11-15T18:30:00.000Z",
    };
    await t.mutation(internal.ingest.upsertConversations, { accountId, conversations: [legacy] });
    await t.action(internal.x.chat.syncAccount, { accountId });
    const row = (await conversations()).find((c) => c.id === ONE_TO_ONE)!;
    expect(row.unavailable).toBeUndefined();
    expect(row.lastMessage?.text).toBe("plain legacy DM");
  });
});

describe("x chat events", () => {
  test("stores ciphertext for the device, once, newest first with key changes", async () => {
    const calls = stubX(defaultRoutes);
    const { t, accountId, as, rows } = await setup();
    await t.action(internal.x.chat.syncAccount, { accountId });

    expect(await as.action(api.x.chat.fetchEvents, { conversationId: ONE_TO_ONE })).toEqual({ fetched: 3, caughtUp: true });
    expect(await as.action(api.x.chat.fetchEvents, { conversationId: ONE_TO_ONE })).toEqual({ fetched: 0, caughtUp: true });
    expect((await rows()).filter((r) => r.kind === "event")).toHaveLength(3);
    expect((await rows()).filter((r) => r.kind === "key")).toHaveLength(1);
    expect(calls.filter((c) => c.path.endsWith("/events")).map((c) => c.url.searchParams.get("max_results"))).toEqual(["10", "7", "10"]);

    const stored = await as.query(api.x.chat.events, { conversationId: ONE_TO_ONE });
    expect(stored!.rows.map((r) => r.id)).toEqual(["2122034395345846272", "2122033388712886272", "2122032382079926272"]);
    expect(stored!.rows[0]).toEqual({ id: "2122034395345846272", encodedEvent: "RVZFTlQtMw==", keyVersion: "1794779680989", senderId: ALICE, createdAt: "2026-11-15T18:30:00.000Z" });
    expect(stored!.keyEvents).toEqual(["S0VZLUNIQU5HRS0x"]);
  });

  test("never serves another user's chats", async () => {
    stubX(defaultRoutes);
    const { t, accountId, as } = await setup();
    await t.action(internal.x.chat.syncAccount, { accountId });
    await as.action(api.x.chat.fetchEvents, { conversationId: ONE_TO_ONE });

    const otherId = await t.run((ctx) => ctx.db.insert("users", {}));
    const other = t.withIdentity({ subject: `${otherId}|session` });
    expect(await other.query(api.x.chat.events, { conversationId: ONE_TO_ONE })).toBeNull();
    await expect(other.action(api.x.chat.fetchEvents, { conversationId: ONE_TO_ONE })).rejects.toThrow();
  });

  test("hands the device its key record and the participants' public keys", async () => {
    stubX(defaultRoutes);
    const { t, accountId, as } = await setup();
    await t.action(internal.x.chat.syncAccount, { accountId });
    const context = await as.action(api.x.chat.keyContext, { conversationId: ONE_TO_ONE });
    expect(context.signingKeyVersion).toBe("1790000000000");
    expect(context.signingKeys.map((k) => k.userId).sort()).toEqual([ALICE, ME, ME]);
  });

  test("sends only what the device encrypted", async () => {
    const calls = stubX(defaultRoutes);
    const { t, accountId, as } = await setup();
    await t.action(internal.x.chat.syncAccount, { accountId });
    await as.action(api.x.chat.send, {
      conversationId: ONE_TO_ONE,
      payload: { messageId: "m-1", encodedMessageCreateEvent: "Q1JFQVRF", encodedMessageEventSignature: "U0lH" },
    });
    expect(JSON.parse(calls.find((c) => c.path.endsWith("/messages"))!.body!)).toEqual({
      message_id: "m-1",
      encoded_message_create_event: "Q1JFQVRF",
      encoded_message_event_signature: "U0lH",
    });
  });

  test("deletes stored ciphertext after X is disconnected", async () => {
    stubX(defaultRoutes);
    const { t, accountId, as, rows } = await setup();
    await t.action(internal.x.chat.syncAccount, { accountId });
    await as.action(api.x.chat.fetchEvents, { conversationId: ONE_TO_ONE });
    await t.mutation(internal.x.chat.purgeOrphans, {});
    expect(await rows()).toHaveLength(4);

    await as.mutation(api.accounts.disconnect, { platform: "x" });
    await t.mutation(internal.x.chat.purgeOrphans, {});
    expect(await rows()).toHaveLength(0);
  });
});

describe("x chat passes", () => {
  test("a bounded fetch leaves a cursor that the next fetch continues, so no history is skipped", async () => {
    const pages = stubX({
      ...defaultRoutes,
      [`GET /2/chat/conversations/${ALICE}/events`]: (url: URL) => {
        const max = Number(url.searchParams.get("max_results"));
        if (url.searchParams.get("pagination_token") === "p2") return json({ data: eventsFixture.data.slice(2), meta: { has_more: false } });
        return json({ data: eventsFixture.data.slice(0, max), meta: { conversation_key_events: eventsFixture.meta.conversation_key_events, has_more: true, next_token: "p2" } });
      },
    });
    const { t, accountId, as, rows } = await setup();
    await t.action(internal.x.chat.syncAccount, { accountId });

    expect(await as.action(api.x.chat.fetchEvents, { conversationId: ONE_TO_ONE, limit: 2 })).toEqual({ fetched: 2, caughtUp: false });
    let [cursor] = await t.run((ctx) => ctx.db.query("x_chat_cursors").collect());
    expect(cursor).toMatchObject({ cursor: "p2", passNewestId: "2122034395345846272" });
    expect(cursor!.sinceId).toBeUndefined();

    expect(await as.action(api.x.chat.fetchEvents, { conversationId: ONE_TO_ONE })).toEqual({ fetched: 1, caughtUp: true });
    [cursor] = await t.run((ctx) => ctx.db.query("x_chat_cursors").collect());
    expect(cursor).toMatchObject({ sinceId: "2122034395345846272" });
    expect(cursor!.cursor).toBeUndefined();
    expect((await rows()).filter((r) => r.kind === "event")).toHaveLength(3);

    expect(await as.action(api.x.chat.fetchEvents, { conversationId: ONE_TO_ONE })).toEqual({ fetched: 0, caughtUp: true });
    expect(pages.filter((c) => c.path.endsWith("/events")).map((c) => c.url.searchParams.get("pagination_token"))).toEqual([null, "p2", null]);
  });

  test("the conversation list only moves chatSince once a pass reaches it", async () => {
    vi.stubEnv("X_DAILY_CHAT_EVENT_READ_BUDGET", "2");
    vi.stubEnv("X_DAILY_CHAT_REALTIME_READ_BUDGET", "0");
    stubX({
      ...defaultRoutes,
      "GET /2/chat/conversations": (url: URL) =>
        json(url.searchParams.get("pagination_token") === "c2" ? { data: [], meta: { has_more: false } } : { ...structuredClone(conversationsFixture), meta: { has_more: true, next_token: "c2" } }),
    });
    const { t, accountId } = await setup();
    const state = () => t.run((ctx) => ctx.db.query("x_sync_state").first());
    await t.action(internal.x.chat.syncAccount, { accountId });
    const first = await state();
    expect(first).toMatchObject({ chatCursor: "c2", chatPassNewestAt: "2026-11-15T18:30:00.000Z" });
    expect(first?.chatSince).toBeUndefined();

    vi.stubEnv("X_DAILY_CHAT_EVENT_READ_BUDGET", "10");
    vi.stubEnv("X_DAILY_CHAT_REALTIME_READ_BUDGET", "0");
    await t.action(internal.x.chat.syncAccount, { accountId });
    const done = await state();
    expect(done?.chatCursor).toBeUndefined();
    expect(done?.chatPassNewestAt).toBeUndefined();
    expect(done?.chatSince).toBe("2026-11-15T18:30:00.000Z");
  });
});
