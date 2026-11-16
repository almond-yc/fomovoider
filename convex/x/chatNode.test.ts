/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import conversationsFixture from "../../src/connectors/x/chat/fixtures/chat-conversations.json";
import activitySamples from "../../src/connectors/x/fixtures/activity-events.json";
import eventsFixture from "../../src/connectors/x/chat/fixtures/chat-events.json";
import keysMe from "../../src/connectors/x/chat/fixtures/chat-public-keys-me.json";
import keysAlice from "../../src/connectors/x/chat/fixtures/chat-public-keys-alice.json";
import sendFixture from "../../src/connectors/x/chat/fixtures/chat-send.json";

// X's server Chat XDK, faked: passcode "2468" unlocks; events "decrypt" to
// "plain:<base64>"; exported keys are fixed bytes the test can look for.
const PASSCODE = "2468";
const RAW_KEYS = new Uint8Array(64).fill(7);
const xdk = vi.hoisted(() => ({ imported: [] as Uint8Array[], unlocks: [] as string[], sent: [] as { conversationId: string; text: string }[] }));
vi.mock("@xdevplatform/chat-xdk-server", () => {
  class ChatXdkError extends Error {
    constructor(
      readonly kind: string,
      message: string,
      readonly guessesRemaining?: number | null,
    ) {
      super(message);
    }
  }
  const createChat = async () => ({
    unlock: async (pin: Uint8Array) => {
      const text = new TextDecoder().decode(pin);
      xdk.unlocks.push(text);
      if (text !== PASSCODE) throw new ChatXdkError("invalidPin", "Wrong PIN", 19);
    },
    exportKeys: () => Uint8Array.from(RAW_KEYS),
    importKeys: ({ keys }: { keys: Uint8Array }) => {
      xdk.imported.push(Uint8Array.from(keys));
    },
    setIdentity: () => undefined,
    setSigningKeys: () => undefined,
    setCacheKeys: () => undefined,
    decryptEvents: ({ events }: { events: string[] }) => ({
      events: events
        .filter((b64) => b64.startsWith("RVZFTlQ"))
        .map((b64) => ({
          originalB64: b64,
          event: { type: "message", senderId: "1234567890", conversationId: "sdk-1", content: { contentType: "text", text: `plain:${b64}` } },
        })),
      errors: {},
    }),
    encryptMessage: ({ conversationId, text }: { conversationId: string; text: string }) => {
      xdk.sent.push({ conversationId, text });
      return { messageId: "m-1", encodedMessageCreateEvent: "Q1JFQVRF", encodedMessageEventSignature: "U0lH" };
    },
    lock: () => undefined,
    free: () => undefined,
  });
  return { createChat, ChatXdkError };
});

const modules = import.meta.glob("/convex/**/*.ts");
const ME = "2244994945";
const ALICE = "1234567890";
const ONE_TO_ONE = `x:${ALICE}-${ME}`;
const me = { id: `x:${ME}`, platform: "x", handle: "me", displayName: "Me" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubX(overrides: Record<string, (url: URL, init?: RequestInit) => Response> = {}) {
  const routes: Record<string, (url: URL, init?: RequestInit) => Response> = {
    "GET /2/chat/conversations": () => json({ ...structuredClone(conversationsFixture), data: [conversationsFixture.data[0]] }),
    [`GET /2/chat/conversations/${ALICE}/events`]: (url) =>
      json(url.searchParams.get("pagination_token") ? { data: [], meta: { has_more: false } } : structuredClone(eventsFixture)),
    [`GET /2/users/${ME}/public_keys`]: () => json(structuredClone(keysMe)),
    [`GET /2/users/${ALICE}/public_keys`]: () => json(structuredClone(keysAlice)),
    [`POST /2/chat/conversations/${ALICE}/messages`]: () => json(structuredClone(sendFixture), 201),
    ...overrides,
  };
  const calls: { key: string; body?: string }[] = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push({ key, body: init?.body ? String(init.body) : undefined });
    const route = routes[key];
    if (!route) throw new Error(`Unmocked request: ${key}`);
    return route(url, init);
  }) as typeof fetch);
  return calls;
}

async function setup() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const as = t.withIdentity({ subject: `${userId}|session` });
  const accountId = await as.mutation(api.accounts.connect, {
    session: { platform: "x", kind: "oauth", accessToken: "access", refreshToken: "refresh", expiresAt: "2099-01-01T00:00:00.000Z" },
  });
  await t.mutation(internal.accounts.verifyIdentity, { accountId, me });
  return { t, userId, accountId, as };
}

async function settle(t: Awaited<ReturnType<typeof setup>>["t"]) {
  vi.useFakeTimers();
  try {
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally {
    vi.useRealTimers();
  }
}

async function everything(t: Awaited<ReturnType<typeof setup>>["t"]) {
  return await t.run(async (ctx) => {
    const tables = ["x_chat_keys", "x_chat_events", "x_chat_cursors", "conversations", "messages", "connectedAccounts", "x_sync_state"] as const;
    return JSON.stringify(await Promise.all(tables.map((table) => ctx.db.query(table).collect())));
  });
}

beforeEach(() => {
  vi.stubEnv("X_CLIENT_ID", "test-client-id");
  vi.stubEnv("X_CHAT_KEY_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
  xdk.imported.length = 0;
  xdk.unlocks.length = 0;
  xdk.sent.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("X Chat passcode", () => {
  test("a wrong passcode is never saved and reports X's remaining tries", async () => {
    stubX();
    const { t, as } = await setup();
    expect(await as.action(api.x.chatNode.setPasscode, { passcode: "1111" })).toEqual({ ok: false, error: { kind: "wrongPasscode", guessesRemaining: 19 } });
    expect(await as.query(api.x.chatKeys.passcodeStatus, {})).toEqual({ status: "none" });
    expect(await t.run((ctx) => ctx.db.query("x_chat_keys").collect())).toEqual([]);
  });

  test("the right passcode saves sealed keys, never the passcode, and decrypts locked chats", async () => {
    stubX();
    const { t, accountId, as } = await setup();
    await t.action(internal.x.chat.syncAccount, { accountId });
    expect((await t.run((ctx) => ctx.db.query("conversations").collect()))[0]?.unavailable?.reason).toBe("locked");

    expect(await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE })).toEqual({ ok: true });
    await settle(t);
    expect(await as.query(api.x.chatKeys.passcodeStatus, {})).toEqual({ status: "active" });

    const stored = await everything(t);
    expect(stored).not.toContain(PASSCODE);
    expect(stored).not.toContain(Buffer.from(RAW_KEYS).toString("base64"));
    const [keys] = await t.run((ctx) => ctx.db.query("x_chat_keys").collect());
    expect(keys).toMatchObject({ status: "active", signingKeyVersion: "1790000000000" });

    const [conversation] = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(conversation?.unavailable).toBeUndefined();
    expect(conversation?.lastMessage?.text).toBe("plain:RVZFTlQtMw==");
    const messages = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(messages.map((m) => m.text).sort()).toEqual(["plain:RVZFTlQtMQ==", "plain:RVZFTlQtMg==", "plain:RVZFTlQtMw=="]);
    expect(Buffer.from(xdk.imported[0]!)).toEqual(Buffer.from(RAW_KEYS));
  });

  test("the cron decrypts new X Chat activity in the background", async () => {
    stubX();
    const { t, accountId, as } = await setup();
    await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE });
    await t.action(internal.x.chat.syncAccount, { accountId });
    await settle(t);
    const [conversation] = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(conversation).toMatchObject({ id: ONE_TO_ONE, lastMessage: { text: "plain:RVZFTlQtMw==" } });
    expect(xdk.unlocks).toEqual([PASSCODE]);
  });

  test("a webhook-delivered X Chat event is decrypted without another event read", async () => {
    const calls = stubX();
    const { t, accountId, as } = await setup();
    await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE });
    await settle(t);
    const before = calls.length;
    const alice = { id: `x:${ALICE}`, platform: "x" as const, handle: "alice", displayName: "Alice" };
    await t.mutation(internal.x.webhook.storeChat, {
      accountId,
      xUserId: ME,
      conversationId: ONE_TO_ONE,
      participants: [me as typeof alice, alice],
      updatedAt: Date.parse("2026-11-15T12:00:00Z"),
      event: { id: "e-9", encodedEvent: "RVZFTlQtOQ==", senderId: ALICE, createdAt: "2026-11-15T12:00:00Z" },
      sortKey: "9999999999999",
      keys: [],
    });
    await t.action(internal.x.chatNode.decryptDelivered, { accountId, conversationId: ONE_TO_ONE });
    await settle(t);
    const [conversation] = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(conversation.unavailable).toBeUndefined();
    expect(conversation.lastMessage).toMatchObject({ text: "plain:RVZFTlQtOQ==" });
    expect(calls.slice(before).filter((c) => c.key.includes("/events"))).toEqual([]);
  });

  test("an event pass cut short leaves the chat locked and a later run finishes it", async () => {
    vi.stubEnv("X_DAILY_CHAT_EVENT_READ_BUDGET", "100");
    let more = true;
    stubX({
      [`GET /2/chat/conversations/${ALICE}/events`]: () =>
        json(more ? { ...structuredClone(eventsFixture), meta: { ...eventsFixture.meta, has_more: true, next_token: "next" } } : { data: [], meta: { has_more: false } }),
    });
    const { t, accountId, as } = await setup();
    await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE });
    await t.action(internal.x.chat.syncAccount, { accountId });
    await settle(t);
    const [cut] = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(cut.unavailable).toMatchObject({ reason: "locked" });
    const [cursor] = await t.run((ctx) => ctx.db.query("x_chat_cursors").collect());
    expect(cursor.cursor).toBe("next");

    more = false;
    await t.action(internal.x.chat.syncAccount, { accountId });
    await settle(t);
    const [done] = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(done.unavailable).toBeUndefined();
    expect(done.lastMessage).toMatchObject({ text: "plain:RVZFTlQtMw==" });
  });

  test("a send whose event isn't fetched yet is still returned as the new message and shown in the inbox", async () => {
    let fail = false;
    stubX({
      [`GET /2/chat/conversations/${ALICE}/events`]: (url) => {
        if (fail) return json({ errors: [{ message: "down" }] }, 503);
        return json(url.searchParams.get("pagination_token") ? { data: [], meta: { has_more: false } } : structuredClone(eventsFixture));
      },
    });
    const { t, accountId, as } = await setup();
    await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE });
    await t.action(internal.x.chat.syncAccount, { accountId });
    await settle(t);
    fail = true;
    const result = await as.action(api.messages.send, { conversationId: ONE_TO_ONE, text: "plain:RVZFTlQtMw==" });
    expect(result).toMatchObject({ ok: true, message: { id: "x:m-1" } });
    const [conversation] = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(conversation.lastMessage).toMatchObject({ id: "x:m-1", isMine: true });
  });

  test("without saved keys an X Chat send fails instead of going out as a plaintext DM", async () => {
    const calls = stubX();
    const { t, accountId, as } = await setup();
    await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE });
    await t.action(internal.x.chat.syncAccount, { accountId });
    await settle(t);
    await as.mutation(api.x.chatKeys.removePasscode, {});
    const result = await as.action(api.messages.send, { conversationId: ONE_TO_ONE, text: "hola" });
    expect(result.ok).toBe(false);
    expect(calls.filter((c) => c.key.startsWith("POST"))).toEqual([]);
  });

  test("a still-locked X Chat row can be sent to once keys are saved, and not before", async () => {
    const calls = stubX();
    const { t, accountId, as } = await setup();
    await t.action(internal.x.chat.syncAccount, { accountId });
    await settle(t);
    const locked = await as.query(api.conversations.get, { conversationId: ONE_TO_ONE });
    expect(locked?.sendBlocked).toEqual({ kind: "unsupported", capability: "sendMessage" });
    expect(await as.action(api.messages.send, { conversationId: ONE_TO_ONE, text: "hola" })).toMatchObject({ ok: false });

    await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("conversations").first();
      await ctx.db.patch(row!._id, { unavailable: { reason: "locked" } });
    });
    expect((await as.query(api.conversations.get, { conversationId: ONE_TO_ONE }))?.sendBlocked).toBeUndefined();
    expect(await as.action(api.messages.send, { conversationId: ONE_TO_ONE, text: "hola" })).toMatchObject({ ok: true });
    expect(xdk.sent).toEqual([{ conversationId: "sdk-1", text: "hola" }]);
    expect(calls.filter((c) => c.key.startsWith("POST /2/dm_conversations"))).toEqual([]);
  });

  test("a one-off backfill fills locked chats from its own read cap, not the daily budget", async () => {
    vi.stubEnv("X_DAILY_CHAT_EVENT_READ_BUDGET", "2");
    vi.stubEnv("X_DAILY_CHAT_REALTIME_READ_BUDGET", "0");
    stubX();
    const { t, accountId, as } = await setup();
    await t.action(internal.x.chat.syncAccount, { accountId });
    await settle(t);
    expect(await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE })).toEqual({ ok: true });
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("x_usage").collect()) await ctx.db.patch(row._id, { used: 2 });
    });
    await settle(t);
    const [stuck] = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(stuck.unavailable).toMatchObject({ reason: "locked" });

    // Convex's runtime doesn't enumerate process.env, so spreading it loses every variable.
    const env = process.env;
    process.env = new Proxy(env, { ownKeys: () => [], getOwnPropertyDescriptor: () => undefined });
    const result = await t.action(internal.x.chatNode.backfill, { accountId, maxReads: 50 }).finally(() => {
      process.env = env;
    });
    expect(result).toMatchObject({ conversations: 1, decrypted: 1, stillLocked: 0 });
    expect(result.eventsFetched).toBeGreaterThan(0);
    expect(result.eventsFetched).toBeLessThanOrEqual(50);
    const usage = await t.run((ctx) => ctx.db.query("x_usage").collect());
    expect(usage.filter((u) => !u.key.startsWith("backfill:")).every((u) => u.used <= 2)).toBe(true);
    const runCounters = usage.filter((u) => u.key.startsWith("backfill:"));
    expect(runCounters.some((u) => u.used > 0)).toBe(true);
    expect(runCounters.every((u) => !/\d{4}-\d{2}-\d{2}/.test(u.key))).toBe(true);
    const [filled] = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(filled.unavailable).toBeUndefined();
    expect(filled.lastMessage).toMatchObject({ text: "plain:RVZFTlQtMw==" });
  });

  test("a token refresh by one step of a run doesn't break the next step's X calls", async () => {
    let refreshToken = "refresh";
    let generation = 0;
    const calls = stubX({
      "POST /2/oauth2/token": (_url, init) => {
        const sent = new URLSearchParams(String(init?.body)).get("refresh_token");
        if (sent !== refreshToken) return json({ error: "invalid_request" }, 400);
        generation++;
        refreshToken = `refresh-${generation}`;
        return json({ token_type: "bearer", access_token: `access-${generation}`, refresh_token: refreshToken, expires_in: 7200 });
      },
    });
    const { t, accountId, as } = await setup();
    await t.action(internal.x.chat.syncAccount, { accountId });
    await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE });
    await t.run(async (ctx) => {
      const account = await ctx.db.get(accountId);
      await ctx.db.patch(accountId, { session: { ...account!.session, expiresAt: "2000-01-01T00:00:00.000Z" } as NonNullable<typeof account>["session"] });
    });
    await t.action(internal.x.chatNode.decryptConversations, { accountId, conversations: [] });
    const [conversation] = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(conversation.unavailable).toBeUndefined();
    expect(generation).toBe(1);
    expect(calls.filter((c) => c.key === "POST /2/oauth2/token")).toHaveLength(1);
  });

  test("keys saved on one app account serve every app account of the same X user", async () => {
    stubX();
    const { t, accountId, as } = await setup();
    const otherUser = await t.run((ctx) => ctx.db.insert("users", {}));
    const other = t.withIdentity({ subject: `${otherUser}|session` });
    const otherAccount = await other.mutation(api.accounts.connect, {
      session: { platform: "x", kind: "oauth", accessToken: "access-2", refreshToken: "refresh-2", expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    await t.mutation(internal.accounts.verifyIdentity, { accountId: otherAccount, me });

    await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE });
    expect(await other.query(api.x.chatKeys.passcodeStatus, {})).toEqual({ status: "active" });
    await t.action(internal.x.chat.syncAccount, { accountId: otherAccount });
    await settle(t);
    const rows = await t.run((ctx) => ctx.db.query("conversations").withIndex("by_userId_and_id", (q) => q.eq("userId", otherUser).eq("id", ONE_TO_ONE)).unique());
    expect(rows?.unavailable).toBeUndefined();
    expect(rows?.lastMessage).toMatchObject({ text: "plain:RVZFTlQtMw==" });
    expect(await other.action(api.messages.send, { conversationId: ONE_TO_ONE, text: "hola" })).toMatchObject({ ok: true });
    expect(xdk.unlocks).toEqual([PASSCODE]);

    await as.mutation(api.accounts.disconnect, { platform: "x" });
    expect(await other.query(api.x.chatKeys.passcodeStatus, {})).toEqual({ status: "active" });
    expect(await t.run((ctx) => ctx.db.query("x_chat_keys").collect())).toHaveLength(1);
    await t.action(internal.x.chat.syncAccount, { accountId: otherAccount });
    await settle(t);
    expect(await other.action(api.messages.send, { conversationId: ONE_TO_ONE, text: "again" })).toMatchObject({ ok: true });

    await other.mutation(api.accounts.disconnect, { platform: "x" });
    expect(await t.run((ctx) => ctx.db.query("x_chat_keys").collect())).toEqual([]);
    void accountId;
  });

  test("a webhook X Chat message is decrypted for every app account of the X user", async () => {
    stubX();
    const { t, as } = await setup();
    const otherUser = await t.run((ctx) => ctx.db.insert("users", {}));
    const other = t.withIdentity({ subject: `${otherUser}|session` });
    const otherAccount = await other.mutation(api.accounts.connect, {
      session: { platform: "x", kind: "oauth", accessToken: "access-2", refreshToken: "refresh-2", expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    await t.mutation(internal.accounts.verifyIdentity, { accountId: otherAccount, me });
    await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE });
    await settle(t);

    const event = structuredClone(activitySamples["chat.received"]).data as Record<string, unknown> & { payload: Record<string, unknown> };
    event.event_uuid = "pushed-1";
    event.filter = { user_id: ME };
    event.payload = { ...event.payload, sender_id: ALICE, conversation_id: `${ALICE}:${ME}`, encoded_event: "RVZFTlQtNw==", created_at_msec: String(Date.parse("2026-11-16T01:00:00Z")) };
    delete event.payload.conversation_key_change_event;
    await t.mutation(internal.x.webhook.accept, { events: [event] });
    await settle(t);

    const rows = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.unavailable).toBeUndefined();
      expect(row.lastMessage).toMatchObject({ text: "plain:RVZFTlQtNw==" });
    }
  });

  test("removePasscode on any linked app account removes the X user's keys for all of them", async () => {
    stubX();
    const { t, as } = await setup();
    const otherUser = await t.run((ctx) => ctx.db.insert("users", {}));
    const other = t.withIdentity({ subject: `${otherUser}|session` });
    const otherAccount = await other.mutation(api.accounts.connect, {
      session: { platform: "x", kind: "oauth", accessToken: "access-2", refreshToken: "refresh-2", expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    await t.mutation(internal.accounts.verifyIdentity, { accountId: otherAccount, me });
    await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE });
    await other.mutation(api.x.chatKeys.removePasscode, {});
    expect(await as.query(api.x.chatKeys.passcodeStatus, {})).toEqual({ status: "none" });
    expect(await t.run((ctx) => ctx.db.query("x_chat_keys").collect())).toEqual([]);
  });

  test("opening a locked X Chat row decrypts it on demand once keys are saved", async () => {
    stubX();
    const { t, accountId, as } = await setup();
    await t.action(internal.x.chat.syncAccount, { accountId });
    await settle(t);
    expect(await as.action(api.x.chatNode.decryptConversation, { conversationId: ONE_TO_ONE })).toEqual({ readable: false });
    await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE });
    expect(await as.action(api.x.chatNode.decryptConversation, { conversationId: ONE_TO_ONE })).toEqual({ readable: true });
    const [row] = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(row.unavailable).toBeUndefined();
  });

  test("removePasscode only removes the caller's current X identity's keys", async () => {
    stubX();
    const { t, as, userId } = await setup();
    const otherUser = await t.run((ctx) => ctx.db.insert("users", {}));
    const other = t.withIdentity({ subject: `${otherUser}|session` });
    const otherAccount = await other.mutation(api.accounts.connect, {
      session: { platform: "x", kind: "oauth", accessToken: "access-2", refreshToken: "refresh-2", expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    await t.mutation(internal.accounts.verifyIdentity, { accountId: otherAccount, me });
    await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE });
    await t.run(async (ctx) => {
      const mine = await ctx.db.query("connectedAccounts").withIndex("by_userId_and_platform", (q) => q.eq("userId", userId).eq("platform", "x")).unique();
      await ctx.db.patch(mine!._id, { me: { id: "x:999", platform: "x", handle: "new", displayName: "New" } });
    });
    await as.mutation(api.x.chatKeys.removePasscode, {});
    expect(await other.query(api.x.chatKeys.passcodeStatus, {})).toEqual({ status: "active" });
  });

  test("background runs get the daily chatEventReads minus the real-time reserve", async () => {
    vi.stubEnv("X_DAILY_CHAT_EVENT_READ_BUDGET", "30");
    const calls = stubX();
    const { t, accountId, as } = await setup();
    await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE });
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("x_usage").collect()) if (row.key.includes(":chatEventReads:")) await ctx.db.patch(row._id, { used: 25 });
    });
    const before = calls.length;
    await t.action(internal.x.chat.syncAccount, { accountId });
    await settle(t);
    expect(calls.slice(before).filter((c) => c.key.includes("/events") || c.key.includes("/public_keys"))).toEqual([]);
    const usage = await t.run((ctx) => ctx.db.query("x_usage").collect());
    expect(usage.find((u) => u.key.includes(":chatEventReads:"))?.used).toBe(25);
  });

  test("a pushed message decrypts from the real-time reserve when sync used up the day's reads", async () => {
    vi.stubEnv("X_DAILY_CHAT_EVENT_READ_BUDGET", "6");
    stubX();
    const { t, accountId, as } = await setup();
    expect(await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE })).toEqual({ ok: true });
    await settle(t);
    const alice = { id: `x:${ALICE}`, platform: "x" as const, handle: "alice", displayName: "Alice" };
    const deliver = async (id: string, encodedEvent: string, sortKey: string) => {
      await t.mutation(internal.x.webhook.storeChat, {
        accountId,
        xUserId: ME,
        conversationId: ONE_TO_ONE,
        participants: [me as typeof alice, alice],
        updatedAt: Date.parse("2026-11-15T12:00:00Z") + Number(sortKey),
        event: { id, encodedEvent, senderId: ALICE, createdAt: "2026-11-15T12:00:00Z" },
        sortKey,
        keys: [],
      });
      await t.action(internal.x.chatNode.decryptDelivered, { accountId, conversationId: ONE_TO_ONE });
    };
    const daily = await t.run((ctx) => ctx.db.query("x_usage").collect());
    expect(daily.find((u) => u.key.includes(":chatEventReads:"))?.used).toBe(1);

    await deliver("e-9", "RVZFTlQtOQ==", "9");
    const [conversation] = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(conversation.unavailable).toBeUndefined();
    expect(conversation.lastMessage).toMatchObject({ text: "plain:RVZFTlQtOQ==" });
    const usage = await t.run((ctx) => ctx.db.query("x_usage").collect());
    expect(usage.find((u) => u.key.includes(":chatEventReads:"))?.used).toBe(1);
    expect(usage.find((u) => u.key.startsWith("backfill:realtime:"))?.used).toBe(2);

    vi.stubEnv("X_DAILY_CHAT_REALTIME_READ_BUDGET", "3");
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("x_chat_public_keys").collect()) await ctx.db.delete(row._id);
    });
    await deliver("e-10", "RVZFTlQtMTA=", "10");
    const [locked] = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(locked.unavailable).toMatchObject({ reason: "locked" });
  });

  test("messages.send sends X Chat messages encrypted on the server", async () => {
    const calls = stubX();
    const { t, accountId, as } = await setup();
    await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE });
    await t.action(internal.x.chat.syncAccount, { accountId });
    await settle(t);

    const result = await as.action(api.messages.send, { conversationId: ONE_TO_ONE, text: "hola" });
    expect(result.ok).toBe(true);
    expect(xdk.sent).toEqual([{ conversationId: "sdk-1", text: "hola" }]);
    const post = calls.find((c) => c.key === `POST /2/chat/conversations/${ALICE}/messages`);
    expect(JSON.parse(post!.body!)).toMatchObject({ message_id: "m-1", encoded_message_create_event: "Q1JFQVRF", encoded_message_event_signature: "U0lH" });
    expect(post!.body).not.toContain("hola");
  });

  test("removing the passcode, or disconnecting X, deletes the keys", async () => {
    stubX();
    const { t, as } = await setup();
    await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE });
    await as.mutation(api.x.chatKeys.removePasscode, {});
    expect(await as.query(api.x.chatKeys.passcodeStatus, {})).toEqual({ status: "none" });

    await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE });
    await as.mutation(api.accounts.disconnect, { platform: "x" });
    expect(await t.run((ctx) => ctx.db.query("x_chat_keys").collect())).toEqual([]);
  });

  test("keys X has replaced are marked invalid and not used", async () => {
    stubX();
    const { t, accountId, as } = await setup();
    await as.action(api.x.chatNode.setPasscode, { passcode: PASSCODE });
    const newer = structuredClone(keysMe);
    newer.data.push({ ...newer.data[1]!, public_key_version: "1800000000000" } as (typeof newer.data)[number]);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("x_chat_public_keys").collect()) await ctx.db.delete(row._id);
    });
    stubX({ [`GET /2/users/${ME}/public_keys`]: () => json(newer) });
    await t.action(internal.x.chat.syncAccount, { accountId });
    await settle(t);
    expect(await as.query(api.x.chatKeys.passcodeStatus, {})).toMatchObject({ status: "invalid" });
    expect(xdk.imported).toEqual([]);
    expect((await t.run((ctx) => ctx.db.query("conversations").collect()))[0]?.unavailable?.reason).toBe("locked");
  });
});
