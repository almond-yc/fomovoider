/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { fixtures } from "../../src/connectors/x/fixtures";
import { createFixtureFetch } from "../../src/connectors/x/mock";

const modules = import.meta.glob("/convex/**/*.ts");
const ME = "x:2244994945";

type Session = { platform: string; kind: "oauth"; accessToken: string; refreshToken?: string; expiresAt?: string };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const fixtureFetch = createFixtureFetch();
  const calls: string[] = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https:\/\/api\.x\.com/, "").split("?")[0]!;
    calls.push(path);
    return overrides[path]?.() ?? fixtureFetch(input, init);
  }) as typeof fetch);
  return calls;
}

async function setup(session: Partial<Session> = {}) {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const as = t.withIdentity({ subject: `${userId}|session` });
  const accountId = await as.mutation(api.accounts.connect, {
    session: { platform: "x", kind: "oauth", accessToken: "access", refreshToken: "refresh", expiresAt: "2099-01-01T00:00:00.000Z", ...session },
  });
  const sync = () => t.action(internal.x.sync.syncAccount, { accountId });
  const account = () => t.run((ctx) => ctx.db.get(accountId));
  const all = <T extends "posts" | "conversations" | "messages" | "x_usage" | "x_sync_state" | "feedCursors">(table: T) =>
    t.run((ctx) => ctx.db.query(table).collect());
  return { t, userId, accountId, as, sync, account, all };
}

beforeEach(() => {
  vi.stubEnv("X_CLIENT_ID", "test-client-id");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("x sync", () => {
  test("verifies the identity, then stores the feed and every DM, normalized and unscored", async () => {
    const calls = stubFetch();
    const { sync, account, all } = await setup();
    await sync();

    const acc = await account();
    expect(acc).toMatchObject({ status: "active", me: { id: ME, handle: "XDevelopers" } });
    expect(acc?.lastError).toBeUndefined();

    const posts = await all("posts");
    expect(posts.map((p) => p.id)).toContain("x:1857000000000000007");
    expect(posts.length).toBeGreaterThan(1);
    for (const post of posts) {
      expect(post).not.toHaveProperty("relevance");
      expect(post.id.startsWith("x:")).toBe(true);
    }
    expect(calls.some((c) => c.endsWith("/liked_tweets") || /\/users\/\d+\/tweets$/.test(c))).toBe(false);

    const conversations = await all("conversations");
    expect(conversations.map((c) => c.id).sort()).toEqual(
      ["x:1234567890-2244994945", "x:1582103724607971328", "x:555000555-2244994945"].sort(),
    );
    expect(await all("messages")).toHaveLength(4);

    expect(await all("feedCursors")).toMatchObject([{ platform: "x" }]);
    expect((await all("x_usage")).length).toBeGreaterThan(0);
    const [state] = await all("x_sync_state");
    expect(state).toMatchObject({ xUserId: ME, dmSinceId: expect.any(String) });
    expect(state?.dmCursor).toBeUndefined();
  });

  test("posts with a contract v5 title still ingest", async () => {
    const home = structuredClone(fixtures["home-timeline"]) as { data: { entities?: { urls?: { title?: string }[] } }[]; meta: Record<string, unknown> };
    delete home.meta.next_token;
    for (const tweet of home.data) for (const url of tweet.entities?.urls ?? []) url.title = "A headline";
    stubFetch({ "/2/users/2244994945/timelines/reverse_chronological": () => json(home) });
    const { sync, account, all } = await setup();
    await sync();
    expect((await account())?.lastError).toBeUndefined();
    expect((await all("posts")).length).toBeGreaterThan(1);
  });

  test("a deployment without X_CLIENT_ID records the error on the account and makes no call", async () => {
    vi.stubEnv("X_CLIENT_ID", "");
    const calls = stubFetch();
    const { sync, account } = await setup();
    await sync();
    expect(calls).toEqual([]);
    expect(await account()).toMatchObject({ status: "error", lastError: { kind: "platform", message: "X_CLIENT_ID is not set" } });
  });

  test("a later sync stores nothing twice", async () => {
    stubFetch();
    const { sync, all } = await setup();
    await sync();
    const counts = [(await all("posts")).length, (await all("messages")).length, (await all("conversations")).length];
    await sync();
    expect([(await all("posts")).length, (await all("messages")).length, (await all("conversations")).length]).toEqual(counts);
  });

  test("refreshes an expired token server-side and saves the rotated session", async () => {
    stubFetch({ "/2/oauth2/token": () => json(fixtures["token-refreshed"]) });
    const { sync, account, all } = await setup({ expiresAt: "2020-01-01T00:00:00.000Z" });
    await sync();
    const acc = await account();
    expect(acc?.status).toBe("active");
    expect(acc?.session).toMatchObject({ kind: "oauth", accessToken: "refreshed-access-token", refreshToken: "rotated-refresh-token" });
    expect(Date.parse((acc?.session as Session).expiresAt!)).toBeGreaterThan(Date.now());
    expect((await all("posts")).length).toBeGreaterThan(0);
  });

  test("a refresh token X rejects marks the account expired", async () => {
    stubFetch({ "/2/oauth2/token": () => json(fixtures["token-invalid"], 400) });
    const { sync, account, all } = await setup({ expiresAt: "2020-01-01T00:00:00.000Z" });
    await sync();
    expect(await account()).toMatchObject({ status: "expired", lastError: { kind: "session_expired" } });
    expect(await all("posts")).toHaveLength(0);
  });

  test("a spent daily budget skips the reads without an account error", async () => {
    for (const name of ["POST_READ", "OWNED_READ", "DM_EVENT_READ"]) vi.stubEnv(`X_DAILY_${name}_BUDGET`, "0");
    const calls = stubFetch();
    const { sync, account, all } = await setup();
    await sync();
    expect(await account()).toMatchObject({ status: "active" });
    expect((await account())?.lastError).toBeUndefined();
    expect(await all("posts")).toHaveLength(0);
    expect(calls).toEqual(["/2/users/me"]);
  });

  test("X refusing for lack of credits is recorded on the account", async () => {
    stubFetch({ "/2/dm_events": () => json(fixtures["error-out-of-credits"], 402) });
    const { sync, account, all } = await setup();
    await sync();
    expect(await account()).toMatchObject({ status: "error", lastError: { kind: "budget_exhausted" } });
    expect(await all("messages")).toHaveLength(0);
  });

  test("the usage budget persists across syncs", async () => {
    vi.stubEnv("X_DAILY_POST_READ_BUDGET", "20");
    stubFetch();
    const { sync, all } = await setup();
    await sync();
    const before = (await all("posts")).length;
    await sync();
    const usage = (await all("x_usage")).find((u) => u.key.includes(":postReads:"));
    expect(usage?.used).toBeLessThanOrEqual(20);
    expect((await all("posts")).length).toBe(before);
  });

  test("a session for a different X identity is purged, not ingested", async () => {
    stubFetch();
    const { t, accountId, sync, account, all } = await setup();
    await t.run((ctx) =>
      ctx.db.patch(accountId as Id<"connectedAccounts">, {
        me: { id: "x:42", platform: "x", handle: "someone", displayName: "Someone" },
      }),
    );
    await sync();
    expect((await account())?.me?.id).toBe(ME);
    expect((await account())?.status).not.toBe("error");
    expect(await all("x_sync_state")).toHaveLength(0);
  });

  test("a DM pass spanning several runs ends by clearing its cursor and polling from the newest event", async () => {
    let page = 0;
    stubFetch({ "/2/dm_events": () => json(page++ === 0 ? fixtures["dm-events"] : { ...fixtures["dm-events"], meta: { result_count: 5 } }) });
    const { sync, all } = await setup();
    await sync();
    let [state] = await all("x_sync_state");
    expect(state).toMatchObject({ dmCursor: "18LAA581J5II7LA00C00ZZZZ", dmPassNewestId: expect.any(String) });
    expect(state?.dmSinceId).toBeUndefined();
    const newest = state!.dmPassNewestId;
    await sync();
    [state] = await all("x_sync_state");
    expect(state?.dmCursor).toBeUndefined();
    expect(state?.dmPassNewestId).toBeUndefined();
    expect(state?.dmSinceId).toBe(newest);
  });

  test("only one sync runs per account, and the app can't request another within 15 minutes", async () => {
    vi.useFakeTimers();
    const calls = stubFetch();
    const { t, as, accountId, sync } = await setup();
    await t.mutation(internal.x.state.claimSync, { accountId });
    await sync();
    expect(calls).toEqual([]);
    await t.mutation(internal.x.state.releaseSync, { accountId });
    expect(await as.mutation(api.x.sync.requestSync, {})).toBe(true);
    expect(await as.mutation(api.x.sync.requestSync, {})).toBe(false);
    vi.useRealTimers();
  });

  test("a refresh that finishes after the user reconnected doesn't overwrite the new session", async () => {
    let reconnect = async () => {};
    stubFetch({
      "/2/oauth2/token": async () => {
        await reconnect();
        return json(fixtures["token-refreshed"]);
      },
    });
    const { t, accountId, sync, account } = await setup({ expiresAt: "2020-01-01T00:00:00.000Z" });
    reconnect = () =>
      t.run(async (ctx) => {
        const current = await ctx.db.get(accountId);
        await ctx.db.patch(accountId, {
          session: { platform: "x", kind: "oauth", accessToken: "new-login" },
          sessionVersion: (current?.sessionVersion ?? 0) + 1,
          status: "pending",
        });
      });
    await sync();
    const acc = await account();
    expect(acc?.session).toMatchObject({ accessToken: "new-login" });
    expect(acc?.status).toBe("pending");
    expect(acc?.lastError).toBeUndefined();
  });

  test("a reconnect while a sync runs: the old sync records nothing and the new account is retried, then verified", async () => {
    vi.useFakeTimers();
    stubFetch();
    const { t, as, accountId, account } = await setup();
    await t.mutation(internal.x.state.claimSync, { accountId });
    await as.mutation(api.accounts.connect, { session: { platform: "x", kind: "oauth", accessToken: "new-login", refreshToken: "r2" } });
    await t.action(internal.x.sync.syncAccount, { accountId });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.map((s) => s.name)).toContain("x/sync:syncAccount");
    expect((await account())?.status).toBe("pending");
    vi.useRealTimers();
  });

  test("a sync whose session was replaced mid-run neither writes nor records an error", async () => {
    let reconnect = async () => {};
    stubFetch({
      "/2/dm_events": async () => {
        await reconnect();
        return json({ ...fixtures["dm-events"], meta: { result_count: 5 } });
      },
    });
    const { t, as, accountId, sync, account, all } = await setup();
    await t.run((ctx) => ctx.db.patch(accountId, { status: "active", me: { id: ME, platform: "x", handle: "XDevelopers", displayName: "X Developers" } }));
    reconnect = async () => {
      await as.mutation(api.accounts.connect, { session: { platform: "x", kind: "oauth", accessToken: "new-login" } });
    };
    await sync();
    expect(await account()).toMatchObject({ status: "pending", session: { accessToken: "new-login" } });
    expect((await account())?.lastError).toBeUndefined();
    expect(await all("messages")).toHaveLength(0);
  });

  test("the cron schedules a sync for every X account that can sync", async () => {
    vi.useFakeTimers();
    const { t, accountId } = await setup();
    await t.run((ctx) => ctx.db.patch(accountId, { status: "active" }));
    await t.mutation(internal.x.sync.syncAll, {});
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.map((s) => s.args[0])).toEqual([{ accountId }]);
    vi.useRealTimers();
  });
});
