/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { CHAT_PLATFORMS } from "./connectors";
import { MOCK_SESSION_STRING } from "../../src/connectors/telegram/mock";
import { TelegramConnector } from "../../src/connectors/telegram/connector";
import { TelegramRpcError } from "../../src/connectors/telegram/transport";
import { RecordingTransport } from "../../src/connectors/telegram/__tests__/helpers";
import { encryptSecret } from "../telegram/secret";

const tg = vi.hoisted(() => ({ transport: undefined as unknown as RecordingTransport }));
vi.mock("../../src/connectors/telegram/gramjs", () => ({ createGramJsTransport: () => tg.transport }));

const modules = import.meta.glob("/convex/**/*.ts");
const ME = "telegram:user:5000000001";
const BOB = "telegram:user:5000000002";
const CLUB = "telegram:channel:1500000001";

beforeEach(() => {
  tg.transport = new RecordingTransport();
  vi.stubEnv("TELEGRAM_API_ID", "12345");
  vi.stubEnv("TELEGRAM_API_HASH", "test-hash");
  vi.stubEnv("TELEGRAM_SESSION_KEY", btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// A signed-in user with a synced Telegram account, connected straight in the tables.
async function connected() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const as = t.withIdentity({ subject: userId + "|session" });
  const deviceId = await t.run(async (ctx) =>
    ctx.db.insert("telegram_sessions", { userId, secret: await encryptSecret(MOCK_SESSION_STRING), telegramUserId: ME, createdAt: Date.now() }),
  );
  const accountId = await t.mutation(internal.accounts.connectDevice, { userId, platform: "telegram", deviceId });
  await t.action(internal.telegram.sync.syncAccount, { accountId });
  const account = () => t.run((ctx) => ctx.db.get(accountId));
  const conversation = (id: string) =>
    t.run((ctx) =>
      ctx.db
        .query("conversations")
        .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", id))
        .unique(),
    );
  const signUp = async () => {
    const otherId = await t.run((ctx) => ctx.db.insert("users", {}));
    return t.withIdentity({ subject: otherId + "|session" });
  };
  return { t, userId, as, accountId, account, conversation, signUp };
}

describe("messages.send for Telegram", () => {
  test("routes to internal.telegram.sync.send and returns the stored message in epoch ms", async () => {
    const { as, t, conversation } = await connected();

    const result = await as.action(api.messages.send, { conversationId: BOB, text: "On my way" });

    expect(result).toMatchObject({ ok: true, message: { id: BOB + ":106", conversationId: BOB, isMine: true, text: "On my way" } });
    if (!result.ok) throw new Error("expected ok");
    expect(typeof result.message.sentAt).toBe("number");
    expect(tg.transport.callsTo("messages.sendMessage")).toHaveLength(1);
    const stored = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(stored.find((m) => m.id === BOB + ":106")).toMatchObject({ isMine: true, sender: { id: ME } });
    expect(await conversation(BOB)).toMatchObject({ unreadCount: 0 });
  });

  test("maps Telegram's refusal to a ConnectorError and sends once", async () => {
    const { as } = await connected();
    tg.transport.on("messages.sendMessage", () => {
      throw new TelegramRpcError(403, "CHAT_WRITE_FORBIDDEN");
    });

    expect(await as.action(api.messages.send, { conversationId: CLUB, text: "hi" })).toEqual({
      ok: false,
      error: { kind: "platform", message: "You can't send messages in this chat." },
    });
    expect(tg.transport.callsTo("messages.sendMessage")).toHaveLength(1);
  });

  test("other users can't send to or mark read the caller's Telegram conversation", async () => {
    const { signUp } = await connected();
    const bob = await signUp();
    const before = tg.transport.calls.length;

    await expect(bob.action(api.messages.send, { conversationId: BOB, text: "hi" })).rejects.toThrow("Conversation not found");
    await expect(bob.action(api.messages.markRead, { conversationId: BOB })).rejects.toThrow("Conversation not found");
    expect(tg.transport.calls.length).toBe(before);
  });

  test("an expired session marks the account expired", async () => {
    const { as, account } = await connected();
    tg.transport.on("messages.sendMessage", () => {
      throw new TelegramRpcError(401, "AUTH_KEY_UNREGISTERED");
    });

    expect(await as.action(api.messages.send, { conversationId: BOB, text: "hi" })).toEqual({ ok: false, error: { kind: "session_expired" } });
    expect(await account()).toMatchObject({ status: "expired" });
  });

  test("an expired session doesn't expire an account the user reconnected during the send", async () => {
    const { as, t, accountId, account } = await connected();
    tg.transport.on("messages.sendMessage", async () => {
      await t.run(async (ctx) => {
        const current = await ctx.db.get(accountId);
        await ctx.db.patch(accountId, { sessionVersion: (current!.sessionVersion ?? 0) + 1 });
      });
      throw new TelegramRpcError(401, "AUTH_KEY_UNREGISTERED");
    });

    expect(await as.action(api.messages.send, { conversationId: BOB, text: "hi" })).toEqual({ ok: false, error: { kind: "session_expired" } });
    expect(await account()).toMatchObject({ status: "active" });
  });
});

describe("messages.markRead for Telegram", () => {
  test("reads the chat on Telegram and stores the new unread count", async () => {
    const { as, conversation } = await connected();

    expect(await as.action(api.messages.markRead, { conversationId: BOB })).toBeNull();

    expect(tg.transport.callsTo("messages.readHistory")[0]).toMatchObject({ maxId: 105 });
    expect((await conversation(BOB))?.unreadCount).toBe(0);
  });

  test("a Telegram failure is swallowed", async () => {
    const { as } = await connected();
    tg.transport.on("messages.readHistory", () => {
      throw new TelegramRpcError(400, "PEER_ID_INVALID");
    });

    expect(await as.action(api.messages.markRead, { conversationId: BOB })).toBeNull();
  });
});

test("registered Telegram capabilities match the connector's own", () => {
  const options: any = { transport: tg.transport, sessions: { load: async () => null }, peers: { get: async () => ({}), put: async () => undefined } };
  expect(CHAT_PLATFORMS.telegram!.capabilities).toEqual(new TelegramConnector(options).capabilities);
});
