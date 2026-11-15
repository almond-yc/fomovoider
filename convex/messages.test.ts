/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { CHAT_PLATFORMS } from "./chat/connectors";
import { fixtures } from "../src/connectors/x/fixtures";
import { createFixtureFetch } from "../src/connectors/x/mock";
import { XConnector } from "../src/connectors/x/connector";

const modules = import.meta.glob("./**/*.ts");
const CONVERSATION = "x:1234567890-2244994945";
const SEND_PATH = "/2/dm_conversations/1234567890-2244994945/messages";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Call = { path: string; method: string; auth: string | null };

function stubFetch(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const fixtureFetch = createFixtureFetch();
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https:\/\/api\.x\.com/, "").split("?")[0]!;
    const headers = new Headers(init?.headers);
    calls.push({ path, method: init?.method ?? "GET", auth: headers.get("authorization") });
    return overrides[path]?.() ?? fixtureFetch(input, init);
  }) as typeof fetch);
  return calls;
}

function person(platform: string, handle: string) {
  return { id: `${platform}:${handle}`, platform, handle, displayName: handle };
}

async function setup() {
  const t = convexTest(schema, modules);
  const signUp = async (token: string, platforms = ["x"]) => {
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const as = t.withIdentity({ subject: `${userId}|session` });
    const accounts: Record<string, Id<"connectedAccounts">> = {};
    for (const platform of platforms) {
      const accountId = await as.mutation(api.accounts.connect, {
        session: { platform, kind: "oauth", accessToken: token, expiresAt: "2099-01-01T00:00:00.000Z" },
      });
      await t.mutation(internal.accounts.verifyIdentity, {
        accountId,
        me: platform === "x" ? person("x", "2244994945") : person(platform, "me"),
      });
      accounts[platform] = accountId;
    }
    const addConversation = (id: string, extra: Record<string, unknown> = {}) =>
      t.mutation(internal.ingest.upsertConversations, {
        accountId: accounts[id.split(":")[0]!]!,
        conversations: [
          {
            id,
            platform: id.split(":")[0]!,
            participants: [person(id.split(":")[0]!, "friend")],
            updatedAt: "2026-11-01T00:00:00Z",
            ...extra,
          },
        ],
      });
    return { userId, as, accounts, addConversation };
  };
  const conversation = (userId: Id<"users">, id = CONVERSATION) =>
    t.run((ctx) =>
      ctx.db
        .query("conversations")
        .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", id))
        .unique(),
    );
  const messages = () => t.run((ctx) => ctx.db.query("messages").collect());
  return { t, signUp, conversation, messages };
}

beforeEach(() => {
  vi.stubEnv("X_CLIENT_ID", "test-client-id");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("messages.send", () => {
  test("routes to the X connector with the caller's session and stores the sent message", async () => {
    const calls = stubFetch();
    const { signUp, conversation, messages } = await setup();
    const alice = await signUp("alice-token");
    await alice.addConversation(CONVERSATION);

    const result = await alice.as.action(api.messages.send, { conversationId: CONVERSATION, text: "hello" });

    expect(result).toMatchObject({
      ok: true,
      message: { conversationId: CONVERSATION, isMine: true, text: "hello", media: [] },
    });
    if (!result.ok) throw new Error("expected ok");
    expect(typeof result.message.sentAt).toBe("number");
    const sends = calls.filter((c) => c.path === SEND_PATH);
    expect(sends).toEqual([{ path: SEND_PATH, method: "POST", auth: "Bearer alice-token" }]);
    const stored = await messages();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ userId: alice.userId, id: result.message.id, text: "hello" });
    expect(stored[0]).not.toHaveProperty("raw");
    const row = await conversation(alice.userId);
    expect(row).toMatchObject({ updatedAt: result.message.sentAt, lastMessage: { id: result.message.id } });
  });

  test("uses the caller's own account when two users have the same conversation", async () => {
    const calls = stubFetch();
    const { signUp } = await setup();
    const alice = await signUp("alice-token");
    const bob = await signUp("bob-token");
    await alice.addConversation(CONVERSATION);
    await bob.addConversation(CONVERSATION);

    await bob.as.action(api.messages.send, { conversationId: CONVERSATION, text: "from bob" });

    expect(calls.filter((c) => c.path === SEND_PATH).map((c) => c.auth)).toEqual(["Bearer bob-token"]);
  });

  test("rejects anonymous callers and conversations of other users, without calling X", async () => {
    const calls = stubFetch();
    const { t, signUp, messages } = await setup();
    const alice = await signUp("alice-token");
    const bob = await signUp("bob-token");
    await alice.addConversation(CONVERSATION);

    await expect(t.action(api.messages.send, { conversationId: CONVERSATION, text: "hi" })).rejects.toThrow(
      "Not signed in",
    );
    await expect(bob.as.action(api.messages.send, { conversationId: CONVERSATION, text: "hi" })).rejects.toThrow(
      "Conversation not found",
    );
    await expect(t.action(api.messages.markRead, { conversationId: CONVERSATION })).rejects.toThrow("Not signed in");
    await expect(bob.as.action(api.messages.markRead, { conversationId: CONVERSATION })).rejects.toThrow(
      "Conversation not found",
    );
    expect(await bob.as.query(api.conversations.get, { conversationId: CONVERSATION })).toBeNull();
    expect(calls).toEqual([]);
    expect(await messages()).toEqual([]);
  });

  test("refuses unavailable conversations, platforms without a sender, and disconnected accounts", async () => {
    const calls = stubFetch();
    const { t, signUp } = await setup();
    const alice = await signUp("alice-token", ["x", "instagram"]);
    expect(CHAT_PLATFORMS.instagram).toBeUndefined();
    await alice.addConversation("x:locked", { unavailable: { reason: "encrypted" } });
    await alice.addConversation("instagram:c1");
    await alice.addConversation(CONVERSATION);
    const send = (conversationId: string) => alice.as.action(api.messages.send, { conversationId, text: "hi" });

    expect(await send("x:locked")).toEqual({ ok: false, error: { kind: "unsupported", capability: "sendMessage" } });
    expect(await send("instagram:c1")).toEqual({ ok: false, error: { kind: "unsupported", capability: "sendMessage" } });

    await t.run((ctx) => ctx.db.patch(alice.accounts.x!, { status: "expired" }));
    expect(await send(CONVERSATION)).toEqual({ ok: false, error: { kind: "session_expired" } });
    expect(await alice.as.query(api.conversations.get, { conversationId: CONVERSATION })).toMatchObject({
      id: CONVERSATION,
      sendBlocked: { kind: "session_expired" },
    });

    await t.run((ctx) => ctx.db.delete(alice.accounts.x!));
    expect(await send(CONVERSATION)).toEqual({ ok: false, error: { kind: "session_expired" } });
    expect(calls).toEqual([]);
  });

  test("maps X refusals to a ConnectorError, sends once, and stores nothing", async () => {
    const calls = stubFetch({ [SEND_PATH]: () => json(fixtures["error-dm-encrypted"], 403) });
    const { signUp, messages } = await setup();
    const alice = await signUp("alice-token");
    await alice.addConversation(CONVERSATION);

    const result = await alice.as.action(api.messages.send, { conversationId: CONVERSATION, text: "hi" });

    expect(result).toEqual({
      ok: false,
      error: { kind: "platform", message: "This chat uses encrypted X Chat, which Fomovoider can't send to yet. Open it on X." },
    });
    expect(calls.filter((c) => c.path === SEND_PATH)).toHaveLength(1);
    expect(await messages()).toEqual([]);
  });

  test("a server error is not retried", async () => {
    const calls = stubFetch({ [SEND_PATH]: () => json({ title: "Internal Error", status: 503 }, 503) });
    const { signUp } = await setup();
    const alice = await signUp("alice-token");
    await alice.addConversation(CONVERSATION);

    const result = await alice.as.action(api.messages.send, { conversationId: CONVERSATION, text: "hi" });

    expect(result.ok).toBe(false);
    expect(calls.filter((c) => c.path === SEND_PATH)).toHaveLength(1);
  });

  test("a spent write budget comes back as budget_exhausted without calling X's send", async () => {
    vi.stubEnv("X_DAILY_WRITE_BUDGET", "0");
    const calls = stubFetch();
    const { signUp } = await setup();
    const alice = await signUp("alice-token");
    await alice.addConversation(CONVERSATION);

    const result = await alice.as.action(api.messages.send, { conversationId: CONVERSATION, text: "hi" });

    expect(result).toMatchObject({ ok: false, error: { kind: "budget_exhausted" } });
    expect(calls.filter((c) => c.path === SEND_PATH)).toEqual([]);
  });

  test("an expired token marks the account expired", async () => {
    stubFetch({
      [SEND_PATH]: () => json(fixtures["error-unauthorized"], 401),
      "/2/oauth2/token": () => json(fixtures["token-invalid"], 400),
    });
    const { t, signUp } = await setup();
    const alice = await signUp("alice-token");
    await t.run((ctx) =>
      ctx.db.patch(alice.accounts.x!, {
        session: { platform: "x", kind: "oauth", accessToken: "alice-token", refreshToken: "r", expiresAt: "2099-01-01T00:00:00.000Z" },
      }),
    );
    await alice.addConversation(CONVERSATION);

    const result = await alice.as.action(api.messages.send, { conversationId: CONVERSATION, text: "hi" });

    expect(result).toEqual({ ok: false, error: { kind: "session_expired" } });
    expect(await t.run((ctx) => ctx.db.get(alice.accounts.x!))).toMatchObject({ status: "expired" });
  });
});

test("a session_expired from a session the user has since replaced leaves the new session active", async () => {
  const { t, signUp } = await setup();
  const alice = await signUp("alice-token");
  await alice.addConversation(CONVERSATION);
  stubFetch({
    [SEND_PATH]: async () => {
      await t.run((ctx) =>
        ctx.db.patch(alice.accounts.x!, {
          session: { platform: "x", kind: "oauth", accessToken: "new-token", expiresAt: "2099-01-01T00:00:00.000Z" },
          sessionVersion: 2,
        }),
      );
      return json(fixtures["error-unauthorized"], 401);
    },
  });

  const result = await alice.as.action(api.messages.send, { conversationId: CONVERSATION, text: "hi" });

  expect(result).toEqual({ ok: false, error: { kind: "session_expired" } });
  expect(await t.run((ctx) => ctx.db.get(alice.accounts.x!))).toMatchObject({ status: "active", sessionVersion: 2 });
});

describe("messages.markRead", () => {
  test("is a no-op for X, which has no markRead", async () => {
    const calls = stubFetch();
    const { signUp, conversation } = await setup();
    const alice = await signUp("alice-token");
    await alice.addConversation(CONVERSATION, { unreadCount: 2 });

    expect(await alice.as.action(api.messages.markRead, { conversationId: CONVERSATION })).toBeNull();

    expect(calls).toEqual([]);
    expect(await conversation(alice.userId)).toMatchObject({ unreadCount: 2 });
  });
});

test("registered capabilities match the X connector's own", () => {
  const x = new XConnector({ config: { clientId: "id", dailyPostReadBudget: 1, dailyDmEventReadBudget: 1, dailyChatEventReadBudget: 1, dailyWriteBudget: 1 } });
  expect(CHAT_PLATFORMS.x!.capabilities).toEqual(x.capabilities);
});
