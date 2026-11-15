/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { MOCK_SESSION_STRING } from "../../src/connectors/telegram/mock";
import { TelegramRpcError } from "../../src/connectors/telegram/transport";
import { RecordingTransport, fixture } from "../../src/connectors/telegram/__tests__/helpers";
import { decryptSecret, encryptSecret } from "./secret";

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
  vi.useRealTimers();
});

async function signedIn() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const as = t.withIdentity({ subject: `${userId}|session` });
  const all = <T extends "conversations" | "messages" | "telegram_sessions" | "telegram_logins" | "telegram_peers" | "connectedAccounts" | "telegram_sync_locks">(table: T) =>
    t.run((ctx) => ctx.db.query(table).collect());
  return { t, userId, as, all };
}

// A user with a Telegram account connected straight in the tables, skipping the login.
async function connected() {
  const s = await signedIn();
  const deviceId = await s.t.run(async (ctx) =>
    ctx.db.insert("telegram_sessions", { userId: s.userId, secret: await encryptSecret(MOCK_SESSION_STRING), telegramUserId: ME, createdAt: Date.now() }),
  );
  const accountId = await s.as.mutation(api.accounts.connect, { session: { platform: "telegram", kind: "device", deviceId } });
  const sync = () => s.t.action(internal.telegram.sync.syncAccount, { accountId });
  const account = () => s.t.run((ctx) => ctx.db.get(accountId));
  return { ...s, deviceId, accountId, sync, account };
}

describe("telegram login", () => {
  test("phone code: connects the account, stores the session encrypted, and syncs", async () => {
    vi.useFakeTimers();
    const { t, as, all } = await signedIn();
    expect(await as.action(api.telegram.login.start, { method: "phone", phone: "+34600000000" })).toEqual({ kind: "code", phone: "+34600000000", via: "app", length: 5 });
    const [login] = await all("telegram_logins");
    expect(login!.secret).not.toContain("mock-pending");
    expect(JSON.parse(await decryptSecret(login!.secret))).toMatchObject({ step: "code", phoneCodeHash: "a1b2c3d4e5" });
    expect(tg.transport.callsTo("auth.sendCode")[0]).toMatchObject({ apiId: 12345, apiHash: "test-hash" });

    const done = await as.action(api.telegram.login.next, { answer: "12345" });
    const [session] = await all("telegram_sessions");
    expect(done).toEqual({ kind: "done", session: { platform: "telegram", kind: "device", deviceId: session!._id } });
    expect(session!.secret).not.toContain(MOCK_SESSION_STRING);
    expect(await decryptSecret(session!.secret)).toBe(MOCK_SESSION_STRING);
    expect(await all("telegram_logins")).toEqual([]);
    const [account] = await all("connectedAccounts");
    expect(account).toMatchObject({ platform: "telegram", status: "pending", session: { kind: "device", deviceId: session!._id } });
    expect(JSON.stringify(account)).not.toContain(MOCK_SESSION_STRING);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await all("connectedAccounts"))[0]).toMatchObject({ status: "active", me: { id: ME, handle: "ada_l" } });
    expect((await all("conversations")).length).toBe(4);
  });

  test("QR code with a 2FA password", async () => {
    const { as } = await signedIn();
    const qr = await as.action(api.telegram.login.start, { method: "qr" });
    expect(qr).toMatchObject({ kind: "qr", url: "tg://login?token=AQIDBAUGBwg" });
    tg.transport.on("auth.exportLoginToken", () => {
      throw new TelegramRpcError(401, "SESSION_PASSWORD_NEEDED");
    });
    expect(await as.action(api.telegram.login.next, {})).toEqual({ kind: "password", hint: "first pet" });
    await expect(as.action(api.telegram.login.next, { answer: "nope" })).rejects.toMatchObject({ data: { kind: "platform", message: "That password is wrong." } });
    expect(await as.action(api.telegram.login.next, { answer: "hunter2" })).toMatchObject({ kind: "done" });
  });

  test("a wrong code keeps the step; cancel and expiry end the login", async () => {
    const { as, all } = await signedIn();
    await as.action(api.telegram.login.start, { method: "phone", phone: "+34600000000" });
    await expect(as.action(api.telegram.login.next, { answer: "00000" })).rejects.toMatchObject({ data: { kind: "platform", message: expect.stringContaining("code is wrong") } });
    expect(await all("telegram_logins")).toHaveLength(1);
    await as.action(api.telegram.login.cancel, {});
    expect(await all("telegram_logins")).toEqual([]);
    await expect(as.action(api.telegram.login.next, { answer: "12345" })).rejects.toMatchObject({ data: { message: expect.stringContaining("expired") } });
  });

  test("requires a signed-in user", async () => {
    const { t } = await signedIn();
    await expect(t.action(api.telegram.login.start, { method: "qr" })).rejects.toThrow("Not signed in");
  });
});

describe("telegram sync", () => {
  test("verifies the identity and stores chats and their recent messages", async () => {
    const { sync, account, all, deviceId } = await connected();
    await sync();
    expect(await account()).toMatchObject({ status: "active", me: { id: ME } });
    const conversations = await all("conversations");
    expect(conversations.map((c) => c.id).sort()).toEqual([BOB, CLUB, "telegram:chat:4000001", "telegram:user:5000000003"].sort());
    expect(conversations.find((c) => c.id === BOB)).toMatchObject({ unreadCount: 2, updatedAt: Date.parse("2025-11-15T19:59:00Z"), lastMessage: { id: `${BOB}:105`, sentAt: Date.parse("2025-11-15T19:59:00Z") } });
    const messages = await all("messages");
    expect(messages.filter((m) => m.conversationId === BOB).map((m) => m.text)).toEqual(expect.arrayContaining(["Are we still on for Tuesday?", "Sure, 7pm works", "[Photo] Look at this view"]));
    expect(messages.filter((m) => m.conversationId === CLUB)).toHaveLength(3);
    expect(messages.every((m) => !("raw" in m))).toBe(true);
    expect((await all("telegram_peers")).filter((p) => p.sessionId === deviceId).map((p) => p.peer).sort()).toEqual(["channel:1500000001", "channel:1500000002", "user:5000000001", "user:5000000002", "user:5000000003"]);
    expect(tg.transport.connects).toBe(1);
    expect(tg.transport.disconnects).toBe(1);
  });

  test("a second run only fetches what changed", async () => {
    const { sync, all } = await connected();
    await sync();
    const before = tg.transport.callsTo("messages.getHistory").length;
    await sync();
    expect(tg.transport.callsTo("messages.getHistory").length).toBe(before);

    const dialogs = fixture("dialogs");
    const bob = dialogs.dialogs.find((d: any) => d.peer.userId === "5000000002");
    bob.topMessage = 107;
    bob.unreadCount = 3;
    const top = { _: "message", id: 107, peerId: { _: "peerUser", userId: "5000000002" }, date: 1763236900, message: "Hello?" };
    dialogs.messages.push(top);
    tg.transport.on("messages.getDialogs", () => dialogs);
    tg.transport.on("messages.getHistory", (req) => ({ _: "messages.messages", messages: Number(req.minId) === 105 ? [top] : [], chats: [], users: [] }));
    await sync();
    const history = tg.transport.callsTo("messages.getHistory").slice(before);
    expect(history.map((h) => [h.peer, h.minId])).toEqual([[expect.objectContaining({ userId: "5000000002" }), 105]]);
    expect((await all("conversations")).find((c) => c.id === BOB)).toMatchObject({ unreadCount: 3, lastMessage: { id: `${BOB}:107`, text: "Hello?" } });
    expect((await all("messages")).some((m) => m.id === `${BOB}:107`)).toBe(true);
  });

  test("never uses another user's Telegram session", async () => {
    const victim = await connected();
    const attacker = await victim.t.run((ctx) => ctx.db.insert("users", {}));
    const as = victim.t.withIdentity({ subject: `${attacker}|session` });
    const accountId = await as.mutation(api.accounts.connect, { session: { platform: "telegram", kind: "device", deviceId: victim.deviceId } });
    await victim.t.action(internal.telegram.sync.syncAccount, { accountId });
    expect(await victim.t.run((ctx) => ctx.db.get(accountId))).toMatchObject({ status: "expired", lastError: { kind: "session_expired" } });
    expect(tg.transport.connects).toBe(0);
    expect(await victim.all("conversations")).toEqual([]);
  });

  test("a revoked session marks the account expired", async () => {
    const { sync, account } = await connected();
    tg.transport.on("users.getUsers", () => {
      throw new TelegramRpcError(401, "AUTH_KEY_UNREGISTERED");
    });
    await sync();
    expect(await account()).toMatchObject({ status: "expired", lastError: { kind: "session_expired" } });
  });

  test("FLOOD_WAIT records rate_limited and holds syncs until it passes", async () => {
    const { sync, account, all } = await connected();
    await sync();
    tg.transport.on("messages.getDialogs", () => {
      throw new TelegramRpcError(420, "FLOOD_WAIT_120");
    });
    const start = Date.now();
    await sync();
    expect(await account()).toMatchObject({ status: "error", lastError: { kind: "rate_limited" } });
    const [lock] = await all("telegram_sync_locks");
    expect(lock!.leaseUntil).toBeGreaterThanOrEqual(start + 119_000);
    const calls = tg.transport.calls.length;
    await sync();
    expect(tg.transport.calls.length).toBe(calls);
  });

  test("requestSync is limited to one every 30 seconds", async () => {
    vi.useFakeTimers();
    const { as } = await connected();
    expect(await as.mutation(api.telegram.state.requestSync, {})).toBe(true);
    expect(await as.mutation(api.telegram.state.requestSync, {})).toBe(false);
    vi.advanceTimersByTime(31_000);
    expect(await as.mutation(api.telegram.state.requestSync, {})).toBe(true);
  });

  test("the cron schedules every Telegram account", async () => {
    vi.useFakeTimers();
    const { t, accountId } = await connected();
    await t.mutation(internal.telegram.state.syncAll, {});
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.map((s) => s.args[0])).toEqual([{ accountId }]);
  });
});

describe("send and markRead", () => {
  test("send stores my message and the refreshed conversation", async () => {
    const { t, sync, accountId, all } = await connected();
    await sync();
    const result = await t.action(internal.telegram.sync.send, { accountId, conversationId: BOB, text: "On my way" });
    expect(result).toMatchObject({ ok: true, message: { id: `${BOB}:106`, isMine: true, text: "On my way" } });
    expect(tg.transport.callsTo("messages.sendMessage")).toHaveLength(1);
    expect((await all("messages")).find((m) => m.id === `${BOB}:106`)).toMatchObject({ isMine: true, sender: { id: ME } });
    expect((await all("conversations")).find((c) => c.id === BOB)).toMatchObject({ unreadCount: 0 });
  });

  test("send reports Telegram's refusal as a ConnectorError without retrying", async () => {
    const { t, sync, accountId } = await connected();
    await sync();
    tg.transport.on("messages.sendMessage", () => {
      throw new TelegramRpcError(403, "CHAT_WRITE_FORBIDDEN");
    });
    expect(await t.action(internal.telegram.sync.send, { accountId, conversationId: CLUB, text: "hi" })).toEqual({
      ok: false,
      error: { kind: "platform", message: "You can't send messages in this chat." },
    });
    expect(tg.transport.callsTo("messages.sendMessage")).toHaveLength(1);
  });

  test("markRead reads the chat on Telegram and stores the new unread count", async () => {
    const { t, sync, accountId, all } = await connected();
    await sync();
    expect(await t.action(internal.telegram.sync.markRead, { accountId, conversationId: BOB })).toEqual({ ok: true });
    expect(tg.transport.callsTo("messages.readHistory")[0]).toMatchObject({ maxId: 105 });
    expect((await all("conversations")).find((c) => c.id === BOB)?.unreadCount).toBe(0);
  });

  test("refuses before the account is verified", async () => {
    const { t, accountId } = await connected();
    expect(await t.action(internal.telegram.sync.send, { accountId, conversationId: BOB, text: "hi" })).toMatchObject({ ok: false });
    expect(tg.transport.callsTo("messages.sendMessage")).toHaveLength(0);
  });
});

describe("cleanup", () => {
  test("logs out and deletes sessions no account uses, after a grace period", async () => {
    vi.useFakeTimers();
    const { t, as, sync, all, deviceId } = await connected();
    await sync();
    await t.mutation(internal.telegram.state.cleanup, {});
    expect(await all("telegram_sessions")).toHaveLength(1);

    await as.mutation(api.accounts.disconnect, { platform: "telegram" });
    await t.mutation(internal.telegram.state.cleanup, {});
    expect(await all("telegram_sessions")).toHaveLength(1);

    vi.advanceTimersByTime(11 * 60 * 1000);
    await t.mutation(internal.telegram.state.cleanup, {});
    expect(await all("telegram_sessions")).toEqual([]);
    expect((await all("telegram_peers")).filter((p) => p.sessionId === (deviceId as Id<"telegram_sessions">))).toEqual([]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(tg.transport.callsTo("auth.logOut")).toHaveLength(1);
  });
});
