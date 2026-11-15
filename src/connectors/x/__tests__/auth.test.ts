import { describe, expect, it } from "vitest";
import { OAuthClient, webCrypto } from "../auth";
import { ConnectorFailure } from "../../types";
import { MENTIONS, NOW, fixture, oauthSession, setup } from "./helpers";

describe("OAuth 2.0 PKCE", () => {
  it("builds the authorize URL with S256 PKCE and the connector scopes", async () => {
    const oauth = new OAuthClient({ clientId: "cid", fetch: () => Promise.reject(new Error("no")), crypto: webCrypto, now: () => NOW });
    const start = await oauth.begin("fomovoider://oauth/x");
    const url = new URL(start.url);
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.search).toContain("scope=tweet.read%20users.read%20tweet.write%20dm.read%20dm.write%20offline.access");
    const p = url.searchParams;
    expect(p.get("client_id")).toBe("cid");
    expect(p.get("redirect_uri")).toBe("fomovoider://oauth/x");
    expect(p.get("state")).toBe(start.state);
    expect(p.get("code_challenge_method")).toBe("S256");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(start.codeVerifier)));
    expect(p.get("code_challenge")).toBe(btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  });

  it("exchanges a code as a public client and returns an oauth Session", async () => {
    const { x } = setup();
    x.on("POST", "/2/oauth2/token", { body: fixture("token") });
    const oauth = new OAuthClient({ clientId: "cid", fetch: x.fetch, crypto: webCrypto, now: () => NOW });
    const session = await oauth.exchangeCode("the-code", "the-verifier", "fomovoider://oauth/x");
    expect(session).toEqual({
      platform: "x",
      kind: "oauth",
      accessToken: fixture("token").access_token,
      refreshToken: fixture("token").refresh_token,
      expiresAt: new Date(NOW + 7200 * 1000).toISOString(),
    });
    const call = x.callsTo("/2/oauth2/token")[0]!;
    expect(call.headers.authorization).toBeUndefined();
    expect(Object.fromEntries(new URLSearchParams(call.body))).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      code_verifier: "the-verifier",
      redirect_uri: "fomovoider://oauth/x",
      client_id: "cid",
    });
  });
});

describe("session refresh", () => {
  it("refreshes near expiry, uses the new token and hands the new session to onSessionRefreshed", async () => {
    const { connector, x, refreshed } = setup();
    x.on("POST", "/2/oauth2/token", { body: fixture("token-refreshed") });
    const account = await connector.account(oauthSession({ expiresAt: new Date(NOW + 60_000).toISOString() }));
    expect(account.me.handle).toBe("XDevelopers");
    expect(Object.fromEntries(new URLSearchParams(x.callsTo("/2/oauth2/token")[0]!.body))).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-1" });
    expect(x.callsTo("/2/users/me")[0]!.headers.authorization).toBe("Bearer refreshed-access-token");
    expect(refreshed).toEqual([
      { platform: "x", kind: "oauth", accessToken: "refreshed-access-token", refreshToken: "rotated-refresh-token", expiresAt: new Date(NOW + 7200 * 1000).toISOString() },
    ]);
  });

  it("refreshes after a 401 and retries once", async () => {
    const { connector, x, refreshed, session } = setup();
    x.on("POST", "/2/oauth2/token", { body: fixture("token-refreshed") });
    x.once("GET", "/2/users/me", { status: 401, body: fixture("error-unauthorized") });
    await connector.account(session);
    expect(x.callsTo("/2/users/me").map((c) => c.headers.authorization)).toEqual(["Bearer access-1", "Bearer refreshed-access-token"]);
    expect(refreshed).toHaveLength(1);
  });

  it("keeps using the refreshed token for the rest of the same call", async () => {
    const { connector, x, session } = setup();
    x.on("POST", "/2/oauth2/token", { body: fixture("token-refreshed") });
    x.once("GET", "/2/users/me", { status: 401, body: fixture("error-unauthorized") });
    x.on("GET", MENTIONS, { body: { meta: { result_count: 0 } } });
    x.on("GET", /reverse_chronological$/, { body: { meta: { result_count: 0 } } });
    await connector.feed(session, { since: "x1|1|1|", limit: 10 });
    expect(x.callsTo(MENTIONS)[0]!.headers.authorization).toBe("Bearer refreshed-access-token");
    expect(x.callsTo("/2/oauth2/token")).toHaveLength(1);
  });

  it("refreshes once when parallel calls share an expiring session", async () => {
    const { connector, x, refreshed } = setup();
    x.on("POST", "/2/oauth2/token", { body: fixture("token-refreshed") });
    const expiring = oauthSession({ expiresAt: new Date(NOW - 1).toISOString() });
    await Promise.all([connector.account(expiring), connector.account(expiring), connector.account(expiring)]);
    expect(x.callsTo("/2/oauth2/token")).toHaveLength(1);
    expect(refreshed).toHaveLength(1);
  });

  it("maps a failed refresh to session_expired", async () => {
    const { connector, x } = setup();
    x.on("POST", "/2/oauth2/token", { status: 400, body: fixture("token-invalid") });
    const err = await connector.account(oauthSession({ expiresAt: new Date(NOW - 1).toISOString() })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorFailure);
    expect((err as ConnectorFailure).error).toEqual({ kind: "session_expired" });
  });

  it("maps an expired token without a refresh token, a repeated 401 and a cookie session to session_expired", async () => {
    const { connector, x, session } = setup();
    await expect(connector.account(oauthSession({ refreshToken: undefined, expiresAt: new Date(NOW - 1).toISOString() }))).rejects.toMatchObject({
      error: { kind: "session_expired" },
    });
    await expect(connector.account({ platform: "x", kind: "cookies", cookies: [] })).rejects.toMatchObject({ error: { kind: "session_expired" } });
    x.on("POST", "/2/oauth2/token", { body: fixture("token-refreshed") });
    x.once("GET", "/2/users/me", { status: 401, body: fixture("error-unauthorized") });
    x.once("GET", "/2/users/me", { status: 401, body: fixture("error-unauthorized") });
    await expect(connector.account(session)).rejects.toMatchObject({ error: { kind: "session_expired" } });
  });
});
