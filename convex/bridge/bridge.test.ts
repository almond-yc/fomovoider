/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob("/convex/**/*.ts");
const SECRET = "test-bridge-secret";

const me = { id: "whatsapp:15550000001", platform: "whatsapp", handle: "15550000001", displayName: "Throwaway" };
const alice = { id: "whatsapp:15550000002", platform: "whatsapp", handle: "15550000002", displayName: "Alice" };
const message = {
  id: "whatsapp:$event1",
  conversationId: "whatsapp:15550000002@s.whatsapp.net",
  sender: alice,
  isMine: false,
  sentAt: "2026-11-15T12:00:00.000Z",
  text: "hello from the bridge",
  media: [],
};
const conversation = {
  id: "whatsapp:15550000002@s.whatsapp.net",
  platform: "whatsapp",
  participants: [alice],
  lastMessage: message,
  updatedAt: message.sentAt,
};

const qrStep = (url: string) => ({ kind: "qr", url, expiresAt: "2026-11-15T12:01:00.000Z" });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubBridge(routes: Record<string, (body: any) => Response>) {
  const calls: { path: string; body: any; auth: string | null }[] = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://bridge.test");
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ path: url.pathname, body, auth: new Headers(init?.headers).get("authorization") });
    return routes[url.pathname]?.(body) ?? json({ error: "not found" }, 404);
  }) as typeof fetch);
  return calls;
}

async function setup() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const as = t.withIdentity({ subject: `${userId}|session` });
  const post = (event: unknown, secret = SECRET) =>
    t.fetch("/bridge/events", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  const pair = async () => {
    const calls = stubBridge({ "/v1/login": () => json(qrStep("2@qr-payload")) });
    await as.action(api.bridge.pairing.start, { platform: "whatsapp", input: { method: "qr" } });
    const [account] = await t.run((ctx) => ctx.db.query("connectedAccounts").collect());
    const [device] = await t.run((ctx) => ctx.db.query("bridge_devices").collect());
    return { calls, accountId: account!._id, deviceId: device!._id };
  };
  return { t, as, post, pair };
}

beforeEach(() => {
  vi.stubEnv("BRIDGE_SECRET", SECRET);
  vi.stubEnv("BRIDGE_URL", "https://bridge.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("bridge host", () => {
  test("pairing creates a device account and exposes the QR code", async () => {
    const { t, as, pair } = await setup();
    const { calls, accountId } = await pair();
    const [device] = await t.run((ctx) => ctx.db.query("bridge_devices").collect());

    expect(calls).toEqual([
      {
        path: "/v1/login",
        body: { accountId, deviceId: device!._id, platform: "whatsapp", method: "qr" },
        auth: `Bearer ${SECRET}`,
      },
    ]);
    const account = await t.run((ctx) => ctx.db.get(accountId));
    expect(account).toMatchObject({ status: "pending", session: { platform: "whatsapp", kind: "device", deviceId: device!._id } });
    expect(await as.query(api.bridge.pairing.status, { platform: "whatsapp" })).toMatchObject({
      status: "pairing",
      step: qrStep("2@qr-payload"),
    });
  });

  test("a phone number starts the pairing-code flow", async () => {
    const { as } = await setup();
    const step = { kind: "showCode", code: "ABCD-EFGH", expiresAt: "2026-11-15T12:03:00.000Z" };
    const calls = stubBridge({ "/v1/login": () => json(step) });
    await as.action(api.bridge.pairing.start, { platform: "whatsapp", input: { method: "phone", phone: "+15550000001" } });
    expect(calls[0]!.body).toMatchObject({ method: "phone", phone: "+15550000001" });
    expect(await as.query(api.bridge.pairing.status, { platform: "whatsapp" })).toMatchObject({ step });
  });

  test("rejects pushes without the shared secret", async () => {
    const { post, pair } = await setup();
    const { accountId, deviceId } = await pair();
    expect((await post({ accountId, deviceId, kind: "connected", me }, "wrong")).status).toBe(401);
  });

  test("connects, then ingests conversations and messages", async () => {
    const { t, as, post, pair } = await setup();
    const { accountId, deviceId } = await pair();

    expect((await post({ accountId, deviceId, kind: "pairing", step: qrStep("2@next") })).status).toBe(204);
    expect((await as.query(api.bridge.pairing.status, { platform: "whatsapp" }))?.step).toEqual(qrStep("2@next"));

    expect((await post({ accountId, deviceId, kind: "connected", me })).status).toBe(204);
    expect(await t.run((ctx) => ctx.db.get(accountId))).toMatchObject({ status: "active", me });
    expect(await as.query(api.bridge.pairing.status, { platform: "whatsapp" })).toMatchObject({ status: "connected" });

    expect((await post({ accountId, kind: "sync", conversations: [conversation], messages: [message] })).status).toBe(204);
    const conversations = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(conversations).toMatchObject([{ id: conversation.id, participants: [alice], updatedAt: Date.parse(message.sentAt) }]);
    const page = await as.query(api.messages.list, {
      conversationId: conversation.id,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page).toMatchObject([{ id: message.id, text: "hello from the bridge", sentAt: Date.parse(message.sentAt) }]);
    expect((await t.run((ctx) => ctx.db.get(accountId)))?.lastSyncedAt).toBeTypeOf("number");
  });

  test("refuses messages before the identity is confirmed, retryably", async () => {
    const { t, post, pair } = await setup();
    const { accountId, deviceId } = await pair();
    const response = await post({ accountId, kind: "sync", conversations: [conversation], messages: [] });
    expect(response.status).toBe(409);
    expect(await t.run((ctx) => ctx.db.query("conversations").collect())).toEqual([]);
  });

  test("refuses accounts that are not bridge accounts", async () => {
    const { t, as, post } = await setup();
    const accountId = await as.mutation(api.accounts.connect, {
      session: { platform: "whatsapp", kind: "oauth", accessToken: "token" },
    });
    expect((await post({ accountId, deviceId: "x", kind: "connected", me })).status).toBe(400);
    expect(await t.run((ctx) => ctx.db.get(accountId))).toMatchObject({ status: "pending" });
  });

  test("refuses a device session pointing at another user's device", async () => {
    const { t, post, pair } = await setup();
    const { accountId, deviceId } = await pair();
    const otherUser = await t.run((ctx) => ctx.db.insert("users", {}));
    const otherDevice = await t.run((ctx) =>
      ctx.db.insert("bridge_devices", { userId: otherUser, platform: "whatsapp", accountId, status: "pairing", updatedAt: 0 }),
    );
    await t.mutation(internal.accounts.connectDevice, {
      userId: (await t.run((ctx) => ctx.db.get(accountId)))!.userId,
      platform: "whatsapp",
      deviceId: otherDevice,
    });
    expect((await post({ accountId, deviceId, kind: "connected", me })).status).toBe(400);
    await expect(
      t.action(internal.bridge.send.send, { accountId, conversationId: conversation.id, text: "hi" }),
    ).rejects.toThrow(/Not a bridge account/);
  });

  test("results of a superseded pairing attempt are ignored", async () => {
    const { t, as, post, pair } = await setup();
    const first = await pair();
    const second = await pair();
    expect(second.accountId).toBe(first.accountId);
    expect((await post({ accountId: first.accountId, deviceId: first.deviceId, kind: "failed", error: "late" })).status).toBe(204);
    expect((await post({ accountId: second.accountId, deviceId: first.deviceId, kind: "connected", me })).status).toBe(204);
    expect(await as.query(api.bridge.pairing.status, { platform: "whatsapp" })).toMatchObject({ status: "pairing", step: qrStep("2@qr-payload") });
    expect(await t.run((ctx) => ctx.db.get(first.accountId))).toMatchObject({ status: "pending" });
  });

  test("a sync arriving after a logout leaves the account expired", async () => {
    const { t, post, pair } = await setup();
    const { accountId, deviceId } = await pair();
    await post({ accountId, deviceId, kind: "connected", me });
    await post({ accountId, kind: "logged_out" });
    expect((await post({ accountId, kind: "sync", conversations: [conversation], messages: [message] })).status).toBe(204);
    expect(await t.run((ctx) => ctx.db.get(accountId))).toMatchObject({ status: "expired" });
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toEqual([]);
  });

  test("a logout on the phone expires the account", async () => {
    const { t, as, post, pair } = await setup();
    const { accountId, deviceId } = await pair();
    await post({ accountId, deviceId, kind: "connected", me });
    expect((await post({ accountId, kind: "logged_out", reason: "LOGGED_OUT" })).status).toBe(204);
    expect(await t.run((ctx) => ctx.db.get(accountId))).toMatchObject({ status: "expired", lastError: { kind: "session_expired" } });
    expect(await as.query(api.bridge.pairing.status, { platform: "whatsapp" })).toMatchObject({ status: "logged_out" });
  });

  test("send goes through the bridge and stores the sent message", async () => {
    const { t, post, pair } = await setup();
    const { accountId, deviceId } = await pair();
    await post({ accountId, deviceId, kind: "connected", me });
    const sent = { ...message, id: "whatsapp:$sent", sender: me, isMine: true, text: "hi" };
    const calls = stubBridge({ "/v1/send": () => json(sent) });

    const result = await t.action(internal.bridge.send.send, { accountId, conversationId: conversation.id, text: "hi" });

    expect(calls[0]).toMatchObject({ path: "/v1/send", body: { accountId, conversationId: conversation.id, text: "hi" } });
    expect(result).toMatchObject({ id: "whatsapp:$sent", isMine: true, sentAt: Date.parse(sent.sentAt) });
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toMatchObject([{ id: "whatsapp:$sent", text: "hi" }]);
  });

  test("a refused send throws and stores nothing", async () => {
    const { t, post, pair } = await setup();
    const { accountId, deviceId } = await pair();
    await post({ accountId, deviceId, kind: "connected", me });
    stubBridge({ "/v1/send": () => json({ error: "whatsapp refused the message" }, 502) });
    await expect(
      t.action(internal.bridge.send.send, { accountId, conversationId: conversation.id, text: "hi" }),
    ).rejects.toThrow(/refused/);
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toEqual([]);
  });
});
