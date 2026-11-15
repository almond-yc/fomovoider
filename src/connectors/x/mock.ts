import { type Session } from "../types";
import type { XDmEvent } from "./api-types";
import { webCrypto } from "./auth";
import { MemoryUsageStore } from "./budget";
import { XConnector } from "./connector";
import { fixtures } from "./fixtures";

export const MOCK_X_SESSION: Session = {
  platform: "x",
  kind: "oauth",
  accessToken: "mock-access-token",
  refreshToken: "mock-refresh-token",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function withoutNextToken<T extends { meta?: object }>(page: T): T {
  const { next_token: _ignored, ...meta } = (page.meta ?? {}) as Record<string, unknown>;
  return { ...page, meta };
}

export function createFixtureFetch(): typeof fetch {
  let sequence = 0;
  const nextId = () => `${Date.now()}${String(sequence++).padStart(6, "0")}`;
  return async (input, init) => {
    const [path = "", query = ""] = String(input).replace(/^https:\/\/api\.x\.com/, "").split("?");
    const method = init?.method ?? "GET";
    const hasSince = /(^|&)since_id=/.test(query);
    const body = typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : undefined;

    if (path === "/2/oauth2/token") return json(fixtures.token);
    if (path === "/2/oauth2/revoke") return json({ revoked: true });
    if (path === "/2/users/me") return json(fixtures["users-me"]);
    if (path.endsWith("/timelines/reverse_chronological")) return json(hasSince ? fixtures["home-timeline-empty"] : withoutNextToken(fixtures["home-timeline"]));
    if (path.endsWith("/mentions")) return json(hasSince ? fixtures["home-timeline-empty"] : fixtures.mentions);
    if (path === "/2/dm_events") return json(withoutNextToken(fixtures["dm-events"]));
    const conversation = /^\/2\/dm_conversations\/([^/]+)\/(dm_events|messages)$/.exec(path);
    if (conversation && method === "GET") {
      const id = decodeURIComponent(conversation[1]!);
      const events = (fixtures["dm-events"].data as XDmEvent[]).filter((e) => e.dm_conversation_id === id && e.event_type === "MessageCreate");
      return json({ data: events, includes: fixtures["dm-events"].includes, meta: { result_count: events.length } });
    }
    if (conversation && method === "POST") {
      return json({ data: { dm_conversation_id: decodeURIComponent(conversation[1]!), dm_event_id: nextId() } }, 201);
    }
    if (path === "/2/tweets" && method === "POST") return json({ data: { id: nextId(), text: body?.text ?? "" } }, 201);
    return json({ title: "Not Found", detail: `No fixture for ${method} ${path}`, type: "about:blank" }, 404);
  };
}

export function createMockXConnector(): XConnector {
  return new XConnector({
    config: { clientId: "mock-client-id", dailyPostReadBudget: 10_000, dailyDmEventReadBudget: 10_000, dailyWriteBudget: 10_000 },
    usage: new MemoryUsageStore(),
    fetch: createFixtureFetch(),
    crypto: webCrypto,
    login: { kind: "oauth", login: async () => MOCK_X_SESSION },
  });
}
