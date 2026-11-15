import type { Session } from "../../types";
import { webCrypto } from "../auth";
import type { XConfig } from "../config";
import { XConnector, type XConnectorOptions } from "../connector";
import { type FixtureName, fixtures } from "../fixtures";

export function fixture<T = any>(name: FixtureName): T {
  return structuredClone(fixtures[name]) as T;
}

export interface MockReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
}

type Handler = MockReply | ((call: RecordedCall) => MockReply);

export class MockX {
  readonly calls: RecordedCall[] = [];
  private readonly routes: { method: string; path: string | RegExp; queue: Handler[]; once?: boolean }[] = [];

  on(method: string, path: string | RegExp, ...replies: Handler[]): this {
    this.routes.push({ method, path, queue: replies });
    return this;
  }

  once(method: string, path: string | RegExp, reply: Handler): this {
    this.routes.unshift({ method, path, queue: [reply], once: true });
    return this;
  }

  callsTo(path: string | RegExp): RecordedCall[] {
    return this.calls.filter((c) => (typeof path === "string" ? c.url.pathname === path : path.test(c.url.pathname)));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      url,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: init?.body === undefined || init.body === null ? undefined : String(init.body),
    };
    this.calls.push(call);
    const route = this.routes.find(
      (r) => r.method === call.method && (typeof r.path === "string" ? r.path === url.pathname : r.path.test(url.pathname)) && r.queue.length,
    );
    if (!route) throw new Error(`Unmocked request: ${call.method} ${url.pathname}`);
    const handler = route.queue.length > 1 || route.once ? route.queue.shift()! : route.queue[0]!;
    const reply = typeof handler === "function" ? handler(call) : handler;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };
}

export const ME_ID = "2244994945";
export const NOW = Date.parse("2026-11-15T20:00:00.000Z");
export const HOME = `/2/users/${ME_ID}/timelines/reverse_chronological`;
export const MENTIONS = `/2/users/${ME_ID}/mentions`;

export const testConfig: XConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  dailyPostReadBudget: 1000,
  dailyDmEventReadBudget: 1000,
  dailyWriteBudget: 100,
};

export function oauthSession(overrides: Partial<Extract<Session, { kind: "oauth" }>> = {}): Session {
  return {
    platform: "x",
    kind: "oauth",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: new Date(NOW + 2 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

export function setup(opts: { config?: Partial<XConfig>; connector?: Partial<XConnectorOptions> } = {}) {
  const x = new MockX();
  let now = NOW;
  const clock = { now: () => now, set: (t: number) => (now = t) };
  const sleeps: number[] = [];
  const refreshed: Session[] = [];
  const connector = new XConnector({
    config: { ...testConfig, ...opts.config },
    fetch: x.fetch,
    crypto: webCrypto,
    now: clock.now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    onSessionRefreshed: (s) => refreshed.push(s),
    ...opts.connector,
  });
  x.on("GET", "/2/users/me", { body: fixture("users-me") });
  return { x, connector, clock, sleeps, refreshed, session: oauthSession() };
}

export function sliced(name: FixtureName, overrides: { nextToken?: string | null } = {}): (call: RecordedCall) => MockReply {
  return (call) => {
    const body = fixture(name);
    const max = Number(call.url.searchParams.get("max_results") ?? 100);
    body.data = (body.data ?? []).slice(0, max);
    if (overrides.nextToken === null) delete body.meta.next_token;
    else if (overrides.nextToken) body.meta.next_token = overrides.nextToken;
    return { body };
  };
}
