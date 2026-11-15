/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { fixtures } from "../../src/connectors/x/fixtures";
import { createFixtureFetch } from "../../src/connectors/x/mock";

const modules = import.meta.glob("/convex/**/*.ts");
const code = { code: "auth-code", codeVerifier: "verifier", redirectUri: "fomovoider://oauth/x" };

function stubFetch(tokenStatus = 200) {
  const fixtureFetch = createFixtureFetch();
  const tokenRequests: { authorization?: string; body: URLSearchParams }[] = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/2/oauth2/token")) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      tokenRequests.push({ authorization: headers.authorization, body: new URLSearchParams(String(init?.body)) });
      if (tokenStatus !== 200) return new Response(JSON.stringify(fixtures["token-invalid"]), { status: tokenStatus });
    }
    return fixtureFetch(input, init);
  }) as typeof fetch);
  return tokenRequests;
}

async function setup() {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  return { t, as: t.withIdentity({ subject: `${userId}|session` }) };
}

beforeEach(() => vi.stubEnv("X_CLIENT_ID", "test-client-id"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("x/auth:connect", () => {
  test("a confidential client exchanges the code with its secret on the server and starts the first sync", async () => {
    vi.stubEnv("X_CLIENT_SECRET", "test-secret");
    const tokenRequests = stubFetch();
    const { t, as } = await setup();
    const result = await as.action(api.x.auth.connect, code);

    expect(result).toEqual({ accountId: expect.any(String), me: expect.objectContaining({ id: "x:2244994945", handle: "XDevelopers" }) });
    expect(JSON.stringify(result)).not.toContain(fixtures.token.access_token);
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]!.authorization).toBe(`Basic ${btoa("test-client-id:test-secret")}`);
    expect(Object.fromEntries(tokenRequests[0]!.body)).toMatchObject({ grant_type: "authorization_code", code: "auth-code", code_verifier: "verifier", redirect_uri: "fomovoider://oauth/x" });

    const account = await t.run((ctx) => ctx.db.get(result.accountId));
    expect(account).toMatchObject({ platform: "x", status: "active", me: { id: "x:2244994945" }, session: { kind: "oauth", accessToken: fixtures.token.access_token } });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.map((s) => [s.name, s.args[0]])).toEqual([["x/sync:syncAccount", { accountId: result.accountId }]]);
  });

  test("a public client sends its client id instead of a secret", async () => {
    const tokenRequests = stubFetch();
    const { as } = await setup();
    await as.action(api.x.auth.connect, code);
    expect(tokenRequests[0]!.authorization).toBeUndefined();
    expect(tokenRequests[0]!.body.get("client_id")).toBe("test-client-id");
  });

  test("a code X rejects fails with a session_expired ConnectorError and stores nothing", async () => {
    stubFetch(400);
    const { t, as } = await setup();
    await expect(as.action(api.x.auth.connect, code)).rejects.toMatchObject({ data: { kind: "session_expired" } });
    expect(await t.run((ctx) => ctx.db.query("connectedAccounts").collect())).toHaveLength(0);
  });

  test("requires a signed-in user", async () => {
    stubFetch();
    const { t } = await setup();
    await expect(t.action(api.x.auth.connect, code)).rejects.toThrow("Not signed in");
  });
});
