import { ConnectorFailure, type ISODate, type Login, type LoginStep, type Person } from "../types";
import type { TelegramConfig } from "./config";
import { rpcErrorMessage, toConnectorFailure } from "./errors";
import { mapUser } from "./mappers";
import type { TelegramClient, TelegramTransport, TlObject } from "./transport";

// Where a login stands between rounds. `session` is the half-authorized
// session string (it already holds an auth key), so it is as secret as a
// finished one: persist it encrypted, and drop it when the login ends.
export interface PendingLogin {
  session: string;
  step: "qr" | "code" | "password";
  phone?: string;
  phoneCodeHash?: string;
}

export type AuthStep = Exclude<LoginStep, { kind: "done" }>;
export type AuthResult = { done: false; step: AuthStep; pending: PendingLogin } | { done: true; session: string; me: Person };

export interface TelegramAuthOptions {
  transport: TelegramTransport;
  config: TelegramConfig;
  now?: () => number;
}

// QR login (auth.exportLoginToken) and phone code login (auth.sendCode,
// auth.signIn), each followed by the 2FA password (auth.checkPassword, SRP)
// when the account has one. Every round opens a client on the pending
// session, so rounds can run in separate processes (Convex actions).
export class TelegramAuth {
  private readonly now: () => number;

  constructor(private readonly opts: TelegramAuthOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(input: { method: "qr" } | { method: "phone"; phone: string }): Promise<AuthResult> {
    return this.round("", async (client) => {
      if (input.method === "qr") return this.qr(client, await client.invoke(this.exportToken()));
      const phone = input.phone.replace(/[\s()-]/g, "");
      if (!/^\+?\d{5,16}$/.test(phone)) throw new ConnectorFailure({ kind: "platform", message: "That phone number isn't valid. Use the international format, e.g. +34600000000." });
      const sent = await client.invoke<TlObject>({
        _: "auth.sendCode",
        phoneNumber: phone,
        apiId: this.opts.config.apiId,
        apiHash: this.opts.config.apiHash,
        settings: { _: "codeSettings" },
      });
      if (sent._ === "auth.sentCodeSuccess") return this.authorized(client, sent.authorization as TlObject);
      const type = sent.type as TlObject | undefined;
      return {
        done: false,
        step: { kind: "code", phone, ...(type ? { via: codeVia(type) } : {}), ...(typeof type?.length === "number" ? { length: type.length } : {}) },
        pending: { session: client.exportSession(), step: "code", phone, phoneCodeHash: String(sent.phoneCodeHash) },
      };
    });
  }

  // The next round: no answer polls a QR login; a code or password answers
  // the step that asked for it.
  next(pending: PendingLogin, answer?: string): Promise<AuthResult> {
    return this.round(pending.session, async (client) => {
      if (pending.step === "qr") {
        try {
          return await this.qr(client, await client.invoke(this.exportToken()));
        } catch (err) {
          if (rpcErrorMessage(err) === "SESSION_PASSWORD_NEEDED") return this.passwordStep(client);
          throw err;
        }
      }
      if (!answer?.trim()) throw new ConnectorFailure({ kind: "platform", message: pending.step === "code" ? "Enter the code Telegram sent." : "Enter your Telegram password." });
      if (pending.step === "code") {
        try {
          const res = await client.invoke<TlObject>({ _: "auth.signIn", phoneNumber: pending.phone, phoneCodeHash: pending.phoneCodeHash, phoneCode: answer.trim() });
          return this.authorized(client, res);
        } catch (err) {
          if (rpcErrorMessage(err) === "SESSION_PASSWORD_NEEDED") return this.passwordStep(client);
          throw err;
        }
      }
      const password = await client.invoke<TlObject>({ _: "account.getPassword" });
      const check = await client.passwordCheck(password, answer);
      return this.authorized(client, await client.invoke({ _: "auth.checkPassword", password: check }));
    });
  }

  // Ends a finished session on Telegram's side (it disappears from Settings →
  // Devices). Errors are ignored: a revoked session is already gone.
  async logOut(session: string): Promise<void> {
    let client: TelegramClient | undefined;
    try {
      client = await this.opts.transport.connect(session);
      await client.invoke({ _: "auth.logOut" });
    } catch {
      // already logged out, or unreachable; nothing else to do
    } finally {
      await client?.disconnect().catch(() => undefined);
    }
  }

  private exportToken(): TlObject {
    return { _: "auth.exportLoginToken", apiId: this.opts.config.apiId, apiHash: this.opts.config.apiHash, exceptIds: [] };
  }

  private async qr(client: TelegramClient, token: TlObject): Promise<AuthResult> {
    if (token._ === "auth.loginTokenMigrateTo") {
      await client.switchDc(token.dcId as number);
      return this.qr(client, await client.invoke({ _: "auth.importLoginToken", token: token.token }));
    }
    if (token._ === "auth.loginTokenSuccess") return this.authorized(client, token.authorization as TlObject);
    const expiresAt: ISODate = new Date((token.expires as number) * 1000).toISOString();
    return {
      done: false,
      step: { kind: "qr", url: `tg://login?token=${base64Url(token.token as Uint8Array)}`, expiresAt },
      pending: { session: client.exportSession(), step: "qr" },
    };
  }

  private async passwordStep(client: TelegramClient): Promise<AuthResult> {
    const password = await client.invoke<TlObject>({ _: "account.getPassword" });
    return {
      done: false,
      step: { kind: "password", ...(typeof password.hint === "string" && password.hint ? { hint: password.hint } : {}) },
      pending: { session: client.exportSession(), step: "password" },
    };
  }

  private authorized(client: TelegramClient, authorization: TlObject): AuthResult {
    if (authorization._ === "auth.authorizationSignUpRequired") {
      throw new ConnectorFailure({ kind: "platform", message: "This phone number has no Telegram account. Sign up in the Telegram app first." });
    }
    const user = authorization.user as TlObject | undefined;
    if (authorization._ !== "auth.authorization" || user?._ !== "user") {
      throw new ConnectorFailure({ kind: "platform", message: `Unexpected Telegram login result ${authorization._}` });
    }
    return { done: true, session: client.exportSession(), me: mapUser(user) };
  }

  private async round(session: string, run: (client: TelegramClient) => Promise<AuthResult>): Promise<AuthResult> {
    let client: TelegramClient | undefined;
    try {
      client = await this.opts.transport.connect(session);
      return await run(client);
    } catch (err) {
      throw toConnectorFailure(err, this.now);
    } finally {
      await client?.disconnect().catch(() => undefined);
    }
  }
}

function codeVia(type: TlObject): string {
  return type._.replace(/^auth\.sentCodeType/, "").replace(/^./, (c) => c.toLowerCase());
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A "steps" Login that keeps the pending login in memory, for one process
// that runs the whole flow (the live smoke script, mock mode). `save` stores
// the finished session string and returns the deviceId that points to it.
// The app's Login wraps the Convex actions in convex/telegram/login.ts instead.
export function createTelegramLogin(auth: TelegramAuth, save: (session: string, me: Person) => Promise<string>): Login {
  let pending: PendingLogin | undefined;
  const settle = async (result: AuthResult): Promise<LoginStep> => {
    if (!result.done) {
      pending = result.pending;
      return result.step;
    }
    pending = undefined;
    return { kind: "done", session: { platform: "telegram", kind: "device", deviceId: await save(result.session, result.me) } };
  };
  return {
    kind: "steps",
    methods: ["qr", "phone"],
    start: async (input) => settle(await auth.start(input)),
    next: async (answer) => {
      if (!pending) throw new ConnectorFailure({ kind: "platform", message: "No Telegram login in progress" });
      return settle(await auth.next(pending, answer));
    },
    cancel: async () => {
      pending = undefined;
    },
  };
}
