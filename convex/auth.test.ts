/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { isAllowedRedirect } from "./auth";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SITE_URL = "http://localhost:8081";

let keys: { JWT_PRIVATE_KEY: string; JWKS: string };

beforeAll(async () => {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  keys = {
    JWT_PRIVATE_KEY: `-----BEGIN PRIVATE KEY----- ${btoa(String.fromCharCode(...pkcs8))} -----END PRIVATE KEY-----`,
    JWKS: JSON.stringify({ keys: [{ use: "sig", kty: jwk.kty, n: jwk.n, e: jwk.e }] }),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubAuthEnv(anonymous?: string) {
  vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site");
  vi.stubEnv("SITE_URL", SITE_URL);
  vi.stubEnv("JWT_PRIVATE_KEY", keys.JWT_PRIVATE_KEY);
  vi.stubEnv("JWKS", keys.JWKS);
  if (anonymous !== undefined) vi.stubEnv("AUTH_ANONYMOUS_ENABLED", anonymous);
}

describe("anonymous sign-in", () => {
  test("is refused unless AUTH_ANONYMOUS_ENABLED is true", async () => {
    const t = convexTest(schema, modules);
    stubAuthEnv();
    await expect(t.action(api.auth.signIn, { provider: "anonymous" })).rejects.toThrow(
      "Anonymous sign-in is disabled",
    );
    vi.stubEnv("AUTH_ANONYMOUS_ENABLED", "1");
    await expect(t.action(api.auth.signIn, { provider: "anonymous" })).rejects.toThrow(
      "Anonymous sign-in is disabled",
    );
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toEqual([]);
  });

  test("creates an anonymous user when enabled", async () => {
    const t = convexTest(schema, modules);
    stubAuthEnv("true");
    const result = await t.action(api.auth.signIn, { provider: "anonymous" });
    expect(result.tokens?.token).toEqual(expect.any(String));
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
    expect(users[0].isAnonymous).toBe(true);
  });
});

describe("password sign-in", () => {
  test("signs up a user who still has to onboard, then signs in", async () => {
    const t = convexTest(schema, modules);
    stubAuthEnv();
    const params = { email: "ada@example.com", password: "correct-horse-1" };
    const signedUp = await t.action(api.auth.signIn, {
      provider: "password",
      params: { ...params, flow: "signUp" },
    });
    expect(signedUp.tokens?.token).toEqual(expect.any(String));
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe("ada@example.com");
    const as = t.withIdentity({ subject: `${users[0]._id}|session` });
    expect(await as.query(api.users.viewer, {})).toEqual({ email: "ada@example.com", accounts: [] });

    const signedIn = await t.action(api.auth.signIn, {
      provider: "password",
      params: { ...params, flow: "signIn" },
    });
    expect(signedIn.tokens?.token).toEqual(expect.any(String));
    await expect(
      t.action(api.auth.signIn, {
        provider: "password",
        params: { ...params, password: "wrong-password", flow: "signIn" },
      }),
    ).rejects.toThrow();
  });
});

describe("OAuth providers", () => {
  test("are refused while commented out", async () => {
    const t = convexTest(schema, modules);
    stubAuthEnv();
    for (const provider of ["google", "apple"]) {
      await expect(t.action(api.auth.signIn, { provider })).rejects.toThrow(
        `Provider \`${provider}\` is not configured`,
      );
    }
  });
});

describe("OAuth redirects", () => {
  test("allow the app scheme and SITE_URL", () => {
    expect(isAllowedRedirect("fomovoider://", SITE_URL, false)).toBe(true);
    expect(isAllowedRedirect(SITE_URL, SITE_URL, false)).toBe(true);
    expect(isAllowedRedirect(`${SITE_URL}/`, `${SITE_URL}/`, false)).toBe(true);
    expect(isAllowedRedirect(`${SITE_URL}/feed?x=1`, SITE_URL, false)).toBe(true);
  });

  test("allow exp:// only when Expo Go is allowed", () => {
    expect(isAllowedRedirect("exp://192.168.1.2:8081", SITE_URL, false)).toBe(false);
    expect(isAllowedRedirect("exp://192.168.1.2:8081", SITE_URL, true)).toBe(true);
  });

  test("refuse other origins", () => {
    expect(isAllowedRedirect("https://evil.example", SITE_URL, true)).toBe(false);
    expect(isAllowedRedirect(`${SITE_URL}.evil.example`, SITE_URL, true)).toBe(false);
    expect(isAllowedRedirect("http://localhost:80810", SITE_URL, true)).toBe(false);
    expect(isAllowedRedirect("javascript:alert(1)", SITE_URL, true)).toBe(false);
  });
});
