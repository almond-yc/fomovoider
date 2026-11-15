/// <reference types="node" />
import bigInt from "big-integer";
import { Api, TelegramClient as GramJsClient } from "telegram";
import { Logger, LogLevel } from "telegram/extensions/Logger";
import { computeCheck } from "telegram/Password";
import { RPCError } from "telegram/errors";
import { StringSession } from "telegram/sessions";
import type { TelegramConfig } from "./config";
import { type TelegramClient, TelegramRpcError, type TelegramTransport, type TlObject } from "./transport";

// GramJS (MTProto over TCP) behind the plain-JSON transport. The only file
// that imports GramJS; Node only (Convex "use node" actions, scripts).
export interface GramJsOptions {
  deviceModel?: string;
  appVersion?: string;
  // Waits Telegram asks for up to this many seconds are slept through;
  // longer ones become rate_limited. Keep it well below an action's runtime.
  floodSleepThreshold?: number;
}

const META = new Set(["CONSTRUCTOR_ID", "SUBCLASS_OF_ID", "className", "classType", "originalArgs", "flags", "flags2"]);

export function createGramJsTransport(config: TelegramConfig, opts: GramJsOptions = {}): TelegramTransport {
  return {
    async connect(session) {
      const client = new GramJsClient(new StringSession(session), config.apiId, config.apiHash, {
        connectionRetries: 2,
        floodSleepThreshold: opts.floodSleepThreshold ?? 5,
        deviceModel: opts.deviceModel ?? "Fomovoider",
        appVersion: opts.appVersion ?? "1.0",
        systemVersion: "server",
        baseLogger: new Logger(LogLevel.ERROR),
      });
      await call(() => client.connect());
      return gramJsClient(client);
    },
  };
}

function gramJsClient(client: GramJsClient): TelegramClient {
  return {
    invoke: async (request) => fromApi(await call(() => client.invoke(toApi(request) as any))),
    switchDc: async (dcId) => {
      await call(() => client._switchDC(dcId));
    },
    passwordCheck: async (password, plain) => fromApi(await call(() => computeCheck(toApi(password) as Api.account.Password, plain))) as TlObject,
    exportSession: () => (client.session as StringSession).save(),
    disconnect: () => client.destroy(),
  };
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof RPCError) throw new TelegramRpcError(err.code ?? 0, rawMessage(err));
    throw err;
  }
}

// GramJS turns some RPC errors into classes with a parsed number; put the raw
// Telegram message back together so the core sees one format.
function rawMessage(err: RPCError): string {
  const e = err as RPCError & { seconds?: number; newDc?: number };
  const byClass: Record<string, string> = {
    FloodWaitError: `FLOOD_WAIT_${e.seconds}`,
    SlowModeWaitError: `SLOWMODE_WAIT_${e.seconds}`,
    FloodTestPhoneWaitError: `FLOOD_TEST_PHONE_WAIT_${e.seconds}`,
    PhoneMigrateError: `PHONE_MIGRATE_${e.newDc}`,
    UserMigrateError: `USER_MIGRATE_${e.newDc}`,
    NetworkMigrateError: `NETWORK_MIGRATE_${e.newDc}`,
    FileMigrateError: `FILE_MIGRATE_${e.newDc}`,
  };
  return byClass[err.constructor.name] ?? err.errorMessage;
}

// {_: "messages.getHistory", ...} → new Api.messages.GetHistory({...}).
// Strings stand for longs (GramJS accepts them), Uint8Arrays become Buffers.
export function toApi(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(toApi);
  if (!value || typeof value !== "object") return value;
  const { _: name, ...fields } = value as TlObject;
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) args[k] = toApi(v);
  if (typeof name !== "string") return args;
  const parts = name.split(".");
  const last = parts.pop()!;
  let ns: any = Api;
  for (const p of parts) ns = ns?.[p];
  const Cls = ns?.[last.charAt(0).toUpperCase() + last.slice(1)];
  if (typeof Cls !== "function") throw new Error(`Unknown TL name ${name}`);
  return new Cls(args);
}

// GramJS objects → plain JSON TL: `_` is the TL name with a lower-case first
// letter of its last segment, big integers become strings, Buffers Uint8Arrays.
export function fromApi(value: unknown): any {
  if (bigInt.isInstance(value)) return value.toString();
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map(fromApi);
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof obj.className === "string") {
    const parts = obj.className.split(".");
    const last = parts.pop()!;
    out._ = [...parts, last.charAt(0).toLowerCase() + last.slice(1)].join(".");
  }
  for (const [k, v] of Object.entries(obj)) {
    if (META.has(k) || k.startsWith("_") || typeof v === "function" || v === undefined || v === null) continue;
    out[k] = fromApi(v);
  }
  return out;
}
