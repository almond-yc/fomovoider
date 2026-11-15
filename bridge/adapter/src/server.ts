import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Adapter, HttpError } from "./adapter.js";

export interface ServerOptions {
  adapter: Adapter;
  hsToken: string;
  bridgeSecret: string;
  // Each bridge's as_token, which it uses to authenticate its status pushes.
  bridgeTokens: Record<string, string>;
}

function bearer(request: IncomingMessage) {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return new URL(request.url ?? "/", "http://adapter").searchParams.get("access_token") ?? undefined;
}

function same(given: string | undefined, expected: string) {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function reply(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function requireString(body: any, key: string): string {
  const value = body?.[key];
  if (typeof value !== "string" || value === "") throw new HttpError(400, `Missing ${key}`);
  return value;
}

// Three audiences: the homeserver (appservice API, hs_token), the bridges
// (status pushes, their as_token), and Convex (/v1/*, the shared bridge secret).
export function createAdapterServer({ adapter, hsToken, bridgeSecret, bridgeTokens }: ServerOptions) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://adapter");
    const path = url.pathname;
    try {
      if (path === "/healthz") return reply(response, 200, { ok: true });

      const txn = /^\/_matrix\/app\/v1\/transactions\/([^/]+)$/.exec(path);
      if (txn && request.method === "PUT") {
        if (!same(bearer(request), hsToken)) return reply(response, 403, { errcode: "M_FORBIDDEN" });
        const body = await readJson(request);
        await adapter.handleTransaction(decodeURIComponent(txn[1]!), body.events ?? []);
        return reply(response, 200, {});
      }
      if (path.startsWith("/_matrix/app/v1/")) {
        if (!same(bearer(request), hsToken)) return reply(response, 403, { errcode: "M_FORBIDDEN" });
        if (path === "/_matrix/app/v1/ping") return reply(response, 200, {});
        return reply(response, 404, { errcode: "M_NOT_FOUND" });
      }

      const status = /^\/bridge-status\/([a-z]+)$/.exec(path);
      if (status && request.method === "POST") {
        const platform = status[1]!;
        const token = bridgeTokens[platform];
        if (!token || !same(bearer(request), token)) return reply(response, 403, { error: "forbidden" });
        await adapter.handleBridgeStatus(platform, await readJson(request));
        return reply(response, 200, {});
      }

      if (path.startsWith("/v1/") && request.method === "POST") {
        if (!same(bearer(request), bridgeSecret)) return reply(response, 401, { error: "unauthorized" });
        const body = await readJson(request);
        const accountId = requireString(body, "accountId");
        switch (path) {
          case "/v1/login": {
            const method = body.method === "phone" ? "phone" : "qr";
            const phone = typeof body.phone === "string" ? body.phone : undefined;
            return reply(
              response,
              200,
              await adapter.login(accountId, requireString(body, "deviceId"), requireString(body, "platform"), method, phone),
            );
          }
          case "/v1/send":
            return reply(
              response,
              200,
              await adapter.send(accountId, requireString(body, "conversationId"), requireString(body, "text")),
            );
          case "/v1/read":
            await adapter.markRead(accountId, requireString(body, "conversationId"));
            return reply(response, 200, {});
          case "/v1/logout":
            await adapter.logout(accountId);
            return reply(response, 200, {});
        }
      }
      return reply(response, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof HttpError) return reply(response, error.status, { error: error.message });
      console.error(`${request.method} ${path} failed:`, error);
      return reply(response, 500, { error: "internal error" });
    }
  });
}
