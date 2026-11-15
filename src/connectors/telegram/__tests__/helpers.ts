import type { Session } from "../../types";
import { TelegramConnector, type TelegramConnectorOptions } from "../connector";
import { type FixtureName, fixtures } from "../fixtures";
import { MOCK_SESSION_STRING, createFixtureTransport } from "../mock";
import { MemoryPeerStore, MemorySessionStore } from "../sessions";
import type { TelegramClient, TelegramTransport, TlObject } from "../transport";

export function fixture<T = any>(name: FixtureName): T {
  return structuredClone(fixtures[name]) as T;
}

export const NOW = Date.parse("2025-11-15T20:00:00.000Z");
export const SESSION: Session = { platform: "telegram", kind: "device", deviceId: "device-1" };

type Handler = (req: TlObject) => unknown;

// The fixture transport, recording every call, with per-method overrides
// (a value, or a function that may throw a TelegramRpcError).
export class RecordingTransport implements TelegramTransport {
  readonly calls: TlObject[] = [];
  readonly sessions: string[] = [];
  connects = 0;
  disconnects = 0;
  private readonly inner = createFixtureTransport();
  private readonly overrides = new Map<string, Handler[]>();

  on(method: string, ...handlers: Handler[]): this {
    this.overrides.set(method, handlers);
    return this;
  }

  callsTo(method: string): TlObject[] {
    return this.calls.filter((c) => c._ === method);
  }

  async connect(session: string): Promise<TelegramClient> {
    this.connects++;
    this.sessions.push(session);
    const inner = await this.inner.connect(session);
    return {
      ...inner,
      invoke: async (req: TlObject): Promise<any> => {
        this.calls.push(structuredClone(req));
        const handlers = this.overrides.get(req._);
        if (handlers?.length) {
          const handler = handlers.length > 1 ? handlers.shift()! : handlers[0]!;
          return handler(req);
        }
        return inner.invoke(req);
      },
      disconnect: async () => {
        this.disconnects++;
      },
    };
  }
}

export function setup(opts: Partial<TelegramConnectorOptions> = {}) {
  const transport = new RecordingTransport();
  const sessions = new MemorySessionStore();
  sessions.sessions.set("device-1", MOCK_SESSION_STRING);
  const peers = new MemoryPeerStore();
  const connector = new TelegramConnector({ transport, sessions, peers, now: () => NOW, ...opts });
  return { transport, sessions, peers, connector, session: SESSION };
}
