/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { fixtures } from "../../src/connectors/x/fixtures";
import { createFixtureFetch } from "../../src/connectors/x/mock";

const modules = import.meta.glob("/convex/**/*.ts");
const DM = "x:1234567890-2244994945";
const MENTION = "x:1857000000000000007";

function stubFetch(overrides: Record<string, () => Response> = {}) {
  const fixtureFetch = createFixtureFetch();
  const calls: { method: string; path: string; body?: string }[] = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https:\/\/api\.x\.com/, "").split("?")[0]!;
    calls.push({ method: init?.method ?? "GET", path, body: typeof init?.body === "string" ? init.body : undefined });
    return overrides[`${init?.method ?? "GET"} ${path}`]?.() ?? fixtureFetch(input, init);
  }) as typeof fetch);
  return calls;
}

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A user with a synced X account (from the fixtures).
async function setup() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const as = t.withIdentity({ subject: `${userId}|session` });
  const accountId = await as.mutation(api.accounts.connect, {
    session: { platform: "x", kind: "oauth", accessToken: "access", refreshToken: "refresh", expiresAt: "2099-01-01T00:00:00.000Z" },
  });
  stubFetch();
  await t.action(internal.x.sync.syncAccount, { accountId });
  const writesUsed = async () =>
    (await t.run((ctx) => ctx.db.query("x_usage").collect())).find((u) => u.key.includes(":writes:"))?.used ?? 0;
  return { t, as, accountId, writesUsed };
}

beforeEach(() => vi.stubEnv("X_CLIENT_ID", "test-client-id"));
afterEach(() => vi.unstubAllEnvs());

describe("internal.x.send.message", () => {
  test("sends the DM, stores it, and uses one daily write", async () => {
    const { t, accountId, writesUsed } = await setup();
    const calls = stubFetch();
    const sent = await t.action(internal.x.send.message, { accountId, conversationId: DM, text: "See you Tuesday" });
    expect(sent).toMatchObject({ conversationId: DM, isMine: true, text: "See you Tuesday", sentAt: expect.any(Number) });
    expect(calls.filter((c) => c.method === "POST")).toEqual([
      { method: "POST", path: "/2/dm_conversations/1234567890-2244994945/messages", body: JSON.stringify({ text: "See you Tuesday" }) },
    ]);
    const stored = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(stored.find((m) => m.id === sent.id)).toMatchObject({ text: "See you Tuesday", isMine: true });
    const conversation = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(conversation.find((c) => c.id === DM)).toMatchObject({ lastMessage: { id: sent.id, text: "See you Tuesday" }, updatedAt: sent.sentAt });
    expect(await writesUsed()).toBe(1);
  });

  test("keeps a newer message as the conversation preview", async () => {
    const { t, accountId } = await setup();
    const future = Date.now() + 60_000;
    await t.run(async (ctx) => {
      const c = (await ctx.db.query("conversations").collect()).find((c) => c.id === DM)!;
      await ctx.db.patch(c._id, { updatedAt: future });
    });
    stubFetch();
    await t.action(internal.x.send.message, { accountId, conversationId: DM, text: "late" });
    const c = (await t.run((ctx) => ctx.db.query("conversations").collect())).find((c) => c.id === DM)!;
    expect(c.updatedAt).toBe(future);
    expect(c.lastMessage?.text).not.toBe("late");
  });

  test("refuses without calling X when the account is expired", async () => {
    const { t, accountId } = await setup();
    await t.run((ctx) => ctx.db.patch(accountId, { status: "expired" }));
    const calls = stubFetch();
    await expect(t.action(internal.x.send.message, { accountId, conversationId: DM, text: "hi" })).rejects.toMatchObject({ data: { kind: "session_expired" } });
    expect(calls).toEqual([]);
  });

  test("a spent write budget fails with budget_exhausted before any send", async () => {
    vi.stubEnv("X_DAILY_WRITE_BUDGET", "0");
    const { t, accountId } = await setup();
    const calls = stubFetch();
    await expect(t.action(internal.x.send.message, { accountId, conversationId: DM, text: "hi" })).rejects.toMatchObject({ data: { kind: "budget_exhausted" } });
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  test("X refusing an encrypted chat is a clear error and gives the write back", async () => {
    const { t, accountId, writesUsed } = await setup();
    stubFetch({ "POST /2/dm_conversations/1234567890-2244994945/messages": () => json(fixtures["error-dm-encrypted"], 403) });
    await expect(t.action(internal.x.send.message, { accountId, conversationId: DM, text: "hi" })).rejects.toMatchObject({
      data: { kind: "platform", message: expect.stringContaining("encrypted X Chat") },
    });
    expect(await writesUsed()).toBe(0);
  });
});

describe("api.x.send.reply", () => {
  test("replies to a mention and stores the reply", async () => {
    const { t, as, writesUsed } = await setup();
    const calls = stubFetch();
    const sent = await as.action(api.x.send.reply, { postId: MENTION, text: "Thanks!" });
    expect(sent).toMatchObject({ id: expect.stringMatching(/^x:/), createdAt: expect.any(Number), permalink: expect.stringContaining("x.com") });
    expect(JSON.parse(calls.find((c) => c.method === "POST")!.body!)).toEqual({ text: "Thanks!", reply: { in_reply_to_tweet_id: "1857000000000000007" } });
    const stored = await t.run((ctx) => ctx.db.query("posts").collect());
    expect(stored.find((p) => p.id === sent.id)).toMatchObject({ text: "Thanks!", replyTo: { id: MENTION } });
    expect(await writesUsed()).toBe(1);
  });

  test("explains X's rule when the post doesn't mention the user", async () => {
    const { as } = await setup();
    stubFetch({ "POST /2/tweets": () => json(fixtures["error-reply-not-summoned"], 403) });
    await expect(as.action(api.x.send.reply, { postId: MENTION, text: "hi" })).rejects.toMatchObject({
      data: { kind: "platform", message: expect.stringContaining("@mention you") },
    });
  });

  test("only for the caller's own posts, and only when signed in", async () => {
    const { t } = await setup();
    const otherId = await t.run((ctx) => ctx.db.insert("users", {}));
    const other = t.withIdentity({ subject: `${otherId}|session` });
    const calls = stubFetch();
    await expect(other.action(api.x.send.reply, { postId: MENTION, text: "hi" })).rejects.toMatchObject({ data: { message: "Post not found" } });
    await expect(t.action(api.x.send.reply, { postId: MENTION, text: "hi" })).rejects.toThrow("Not signed in");
    expect(calls).toEqual([]);
  });

  test("refuses another platform's post without using a write", async () => {
    const { t, as, writesUsed } = await setup();
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...post } = (await ctx.db.query("posts").collect()).find((p) => p.id === MENTION)!;
      await ctx.db.insert("posts", { ...post, platform: "instagram", id: "instagram:1" });
    });
    const calls = stubFetch();
    await expect(as.action(api.x.send.reply, { postId: "instagram:1", text: "hi" })).rejects.toMatchObject({ data: { message: "Post not found" } });
    expect(calls).toEqual([]);
    expect(await writesUsed()).toBe(0);
  });
});
