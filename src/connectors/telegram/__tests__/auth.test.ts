import { describe, expect, it } from "vitest";
import { TelegramAuth, createTelegramLogin } from "../auth";
import { MOCK_SESSION_STRING, MOCK_TELEGRAM_CONFIG, createMockTelegramConnector } from "../mock";
import { TelegramRpcError } from "../transport";
import { NOW, RecordingTransport, fixture } from "./helpers";

function auth() {
  const transport = new RecordingTransport();
  return { transport, auth: new TelegramAuth({ transport, config: MOCK_TELEGRAM_CONFIG, now: () => NOW }) };
}

const ME = { id: "telegram:user:5000000001", handle: "ada_l", displayName: "Ada Lovelace" };

describe("QR login", () => {
  it("shows a tg://login code, then signs in on the next poll", async () => {
    const { auth: a, transport } = auth();
    const first = await a.start({ method: "qr" });
    expect(first).toEqual({
      done: false,
      step: { kind: "qr", url: "tg://login?token=AQIDBAUGBwg", expiresAt: "2025-11-15T20:00:30.000Z" },
      pending: { session: "mock-pending", step: "qr" },
    });
    expect(transport.callsTo("auth.exportLoginToken")[0]).toEqual({ _: "auth.exportLoginToken", apiId: 1, apiHash: "mock-api-hash", exceptIds: [] });
    if (first.done) throw new Error("unreachable");
    const second = await a.next(first.pending);
    expect(second).toMatchObject({ done: true, session: MOCK_SESSION_STRING, me: ME });
    expect(transport.sessions).toEqual(["", "mock-pending"]);
    expect(transport.disconnects).toBe(2);
  });

  it("moves to the user's data center when Telegram asks", async () => {
    const { auth: a, transport } = auth();
    const switched: number[] = [];
    const connect = transport.connect.bind(transport);
    transport.connect = async (s) => ({ ...(await connect(s)), switchDc: async (dc: number) => void switched.push(dc) });
    transport.on("auth.exportLoginToken", () => ({ _: "auth.loginTokenMigrateTo", dcId: 4, token: new Uint8Array([9]) }));
    transport.on("auth.importLoginToken", () => fixture("login-token-success"));
    const result = await a.next({ session: "mock-pending", step: "qr" });
    expect(switched).toEqual([4]);
    expect(transport.callsTo("auth.importLoginToken")[0]).toEqual({ _: "auth.importLoginToken", token: new Uint8Array([9]) });
    expect(result).toMatchObject({ done: true, me: ME });
  });

  it("asks for the 2FA password when the account has one", async () => {
    const { auth: a, transport } = auth();
    transport.on("auth.exportLoginToken", () => {
      throw new TelegramRpcError(401, "SESSION_PASSWORD_NEEDED");
    });
    const result = await a.next({ session: "mock-pending", step: "qr" });
    expect(result).toEqual({ done: false, step: { kind: "password", hint: "first pet" }, pending: { session: "mock-pending", step: "password" } });
  });
});

describe("phone login", () => {
  it("sends a code, then signs in with it", async () => {
    const { auth: a, transport } = auth();
    const first = await a.start({ method: "phone", phone: "+34 600 000 000" });
    expect(first).toEqual({
      done: false,
      step: { kind: "code", phone: "+34600000000", via: "app", length: 5 },
      pending: { session: "mock-pending", step: "code", phone: "+34600000000", phoneCodeHash: "a1b2c3d4e5" },
    });
    expect(transport.callsTo("auth.sendCode")[0]).toMatchObject({ phoneNumber: "+34600000000", apiId: 1, apiHash: "mock-api-hash", settings: { _: "codeSettings" } });
    if (first.done) throw new Error("unreachable");
    expect(await a.next(first.pending, "12345")).toMatchObject({ done: true, session: MOCK_SESSION_STRING, me: ME });
    expect(transport.callsTo("auth.signIn")[0]).toEqual({ _: "auth.signIn", phoneNumber: "+34600000000", phoneCodeHash: "a1b2c3d4e5", phoneCode: "12345" });
  });

  it("explains a wrong code and keeps the step", async () => {
    const { auth: a } = auth();
    const pending = { session: "mock-pending", step: "code" as const, phone: "+34600000000", phoneCodeHash: "a1b2c3d4e5" };
    await expect(a.next(pending, "00000")).rejects.toMatchObject({ error: { kind: "platform", message: expect.stringContaining("code is wrong") } });
    await expect(a.next(pending)).rejects.toMatchObject({ error: { kind: "platform", message: "Enter the code Telegram sent." } });
  });

  it("asks for the password after the code, and checks it with SRP", async () => {
    const { auth: a, transport } = auth();
    const pending = { session: "mock-pending", step: "code" as const, phone: "+34600000000", phoneCodeHash: "a1b2c3d4e5" };
    const step = await a.next(pending, "22222");
    expect(step).toMatchObject({ done: false, step: { kind: "password", hint: "first pet" }, pending: { step: "password" } });
    if (step.done) throw new Error("unreachable");
    await expect(a.next(step.pending, "wrong")).rejects.toMatchObject({ error: { kind: "platform", message: "That password is wrong." } });
    expect(await a.next(step.pending, "hunter2")).toMatchObject({ done: true, me: ME });
    expect(transport.callsTo("auth.checkPassword").at(-1)).toEqual({ _: "auth.checkPassword", password: { _: "inputCheckPasswordSRP", plain: "hunter2" } });
  });

  it("refuses invalid numbers before calling Telegram, and numbers without an account", async () => {
    const { auth: a, transport } = auth();
    await expect(a.start({ method: "phone", phone: "call me" })).rejects.toMatchObject({ error: { kind: "platform" } });
    expect(transport.calls).toHaveLength(0);
    transport.on("auth.signIn", () => ({ _: "auth.authorizationSignUpRequired" }));
    await expect(a.next({ session: "mock-pending", step: "code", phone: "+1555", phoneCodeHash: "h" }, "12345")).rejects.toMatchObject({
      error: { kind: "platform", message: expect.stringContaining("Sign up in the Telegram app first") },
    });
  });

  it("maps a code flood to rate_limited", async () => {
    const { auth: a, transport } = auth();
    transport.on("auth.sendCode", () => {
      throw new TelegramRpcError(420, "FLOOD_WAIT_600");
    });
    await expect(a.start({ method: "phone", phone: "+34600000000" })).rejects.toMatchObject({ error: { kind: "rate_limited", retryAt: "2025-11-15T20:10:00.000Z" } });
  });
});

describe("logOut", () => {
  it("ends the session and ignores failures", async () => {
    const { auth: a, transport } = auth();
    await a.logOut(MOCK_SESSION_STRING);
    expect(transport.callsTo("auth.logOut")).toHaveLength(1);
    transport.on("auth.logOut", () => {
      throw new TelegramRpcError(401, "AUTH_KEY_UNREGISTERED");
    });
    await expect(a.logOut(MOCK_SESSION_STRING)).resolves.toBeUndefined();
  });
});

describe("createTelegramLogin", () => {
  it("runs the steps in one process and saves the finished session", async () => {
    const { auth: a } = auth();
    const saved: string[] = [];
    const login = createTelegramLogin(a, async (session) => {
      saved.push(session);
      return "device-9";
    });
    if (login.kind !== "steps") throw new Error("unreachable");
    expect(login.methods).toEqual(["qr", "phone"]);
    await expect(login.next()).rejects.toMatchObject({ error: { kind: "platform" } });
    expect(await login.start({ method: "phone", phone: "+34600000000" })).toMatchObject({ kind: "code" });
    expect(await login.next("12345")).toEqual({ kind: "done", session: { platform: "telegram", kind: "device", deviceId: "device-9" } });
    expect(saved).toEqual([MOCK_SESSION_STRING]);
  });
});

describe("createMockTelegramConnector", () => {
  it("serves fixtures without credentials, including a fresh login", async () => {
    const tg = createMockTelegramConnector();
    if (tg.login.kind !== "steps") throw new Error("unreachable");
    expect(await tg.login.start({ method: "qr" })).toMatchObject({ kind: "qr" });
    const done = await tg.login.next();
    if (done.kind !== "done") throw new Error("expected done");
    expect((await tg.account(done.session)).me.handle).toBe("ada_l");
    const chats = await tg.conversations(done.session, { limit: 20 });
    expect(chats.items).toHaveLength(4);
    const messages = await tg.messages(done.session, chats.items[0]!.id, { limit: 20 });
    expect(messages.items.length).toBeGreaterThan(0);
    expect((await tg.send(done.session, chats.items[0]!.id, { text: "hi" })).isMine).toBe(true);
    await tg.markRead!(done.session, chats.items[0]!.id);
    await tg.close();
  });
});
