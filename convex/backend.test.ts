/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { RELEVANCE_THRESHOLD } from "./feed";
import crons from "./crons";
import { RETENTION_DAYS } from "./retention";
import schema from "./schema";
import { MAX_TEXT_LENGTH, type PostInput } from "./lib/validators";

const modules = import.meta.glob("./**/*.ts");
const page = { paginationOpts: { numItems: 50, cursor: null } };

function person(platform: string, handle: string) {
  return { id: `${platform}:${handle}`, platform, handle, displayName: handle };
}

async function setup() {
  const t = convexTest(schema, modules);
  const signUp = async () => {
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const as = t.withIdentity({ subject: `${userId}|session` });
    return { userId, as };
  };
  // App connects, then the connector confirms the identity, as a sync would.
  const connect = async (
    user: { as: ReturnType<typeof t.withIdentity> },
    platform: string,
    handle = "me",
  ) => {
    const accountId = await user.as.mutation(api.accounts.connect, {
      session: { platform, kind: "oauth", accessToken: `token-${platform}-${handle}` },
    });
    await t.mutation(internal.accounts.verifyIdentity, { accountId, me: person(platform, handle) });
    await t.finishAllScheduledFunctions(() => {});
    return accountId;
  };
  return { t, signUp, connect };
}

function post(platform: string, n: number, extra: Partial<PostInput> = {}): PostInput {
  const id = `${platform}:${n}`;
  return {
    id,
    platform,
    author: person(platform, "author"),
    createdAt: new Date(Date.UTC(2026, 10, 1, n)).toISOString(),
    text: `post ${n}`,
    media: [],
    permalink: `https://example.com/${id}`,
    ...extra,
  };
}

const ids = (result: { page: { id: string }[] }) => result.page.map((p) => p.id);

describe("auth", () => {
  test("public functions reject anonymous callers", async () => {
    const { t } = await setup();
    await expect(t.query(api.feed.page, page)).rejects.toThrow("Not signed in");
    await expect(t.query(api.conversations.list, page)).rejects.toThrow("Not signed in");
    await expect(
      t.query(api.messages.list, { conversationId: "x:c", ...page }),
    ).rejects.toThrow("Not signed in");
    await expect(
      t.mutation(api.feed.markCaughtUp, { until: Date.parse("2026-11-01T00:00:00Z") }),
    ).rejects.toThrow("Not signed in");
    await expect(t.query(api.accounts.list, {})).rejects.toThrow("Not signed in");
    await expect(t.mutation(api.accounts.disconnect, { platform: "x" })).rejects.toThrow(
      "Not signed in",
    );
  });

  test("accounts.list never returns the session", async () => {
    const { signUp, connect } = await setup();
    const alice = await signUp();
    await connect(alice, "x");
    expect(await alice.as.query(api.accounts.list, {})).toEqual([
      { platform: "x", status: "active", me: person("x", "me") },
    ]);
  });
});

describe("ingest", () => {
  test("upsertPosts inserts, then replaces by namespaced id, and drops raw", async () => {
    const { t, signUp, connect } = await setup();
    const accountId = await connect(await signUp(), "x");
    await t.mutation(internal.ingest.upsertPosts, {
      accountId,
      posts: [post("x", 1, { raw: { secret: true } })],
    });
    await t.mutation(internal.ingest.upsertPosts, {
      accountId,
      posts: [post("x", 1, { text: "edited", createdAt: "2026-11-01T01:00:00+00:00" })],
      page: { cursor: "c1", caughtUp: true },
    });
    const rows = await t.run((ctx) => ctx.db.query("posts").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("edited");
    expect(rows[0].createdAt).toBe(Date.parse("2026-11-01T01:00:00Z"));
    expect(rows[0]).not.toHaveProperty("raw");
    const cursors = await t.run((ctx) => ctx.db.query("feedCursors").collect());
    expect(cursors).toMatchObject([{ platform: "x", cursor: "c1", caughtUp: true }]);
  });

  test("upsertPosts stores story format, expiresAt and extracted fields", async () => {
    const { t, signUp, connect } = await setup();
    const accountId = await connect(await signUp(), "instagram");
    await t.mutation(internal.ingest.upsertPosts, {
      accountId,
      posts: [
        post("instagram", 1, {
          format: "story",
          expiresAt: "2026-11-02T01:00:00+00:00",
          extracted: {
            place: { name: "Lisbon", lat: 38.72, lng: -9.14 },
            event: { title: "Housewarming", startsAt: "2026-11-20T19:00:00+00:00", place: "Alfama" },
            lifeUpdate: "Moved to Lisbon",
          },
        }),
      ],
    });
    const [row] = await t.run((ctx) => ctx.db.query("posts").collect());
    expect(row).toMatchObject({
      format: "story",
      expiresAt: Date.parse("2026-11-02T01:00:00Z"),
      extracted: {
        place: { name: "Lisbon", lat: 38.72, lng: -9.14 },
        event: { title: "Housewarming", startsAt: Date.parse("2026-11-20T19:00:00Z"), place: "Alfama" },
        lifeUpdate: "Moved to Lisbon",
      },
    });
  });

  test("upsertPosts rejects posts from another platform or with bare ids", async () => {
    const { t, signUp, connect } = await setup();
    const accountId = await connect(await signUp(), "x");
    await expect(
      t.mutation(internal.ingest.upsertPosts, { accountId, posts: [post("instagram", 1)] }),
    ).rejects.toThrow("is not from x");
    await expect(
      t.mutation(internal.ingest.upsertPosts, { accountId, posts: [{ ...post("x", 1), id: "1" }] }),
    ).rejects.toThrow("not namespaced");
  });

  test("ingest refuses until the connector verified the identity", async () => {
    const { t, signUp } = await setup();
    const alice = await signUp();
    const accountId = await alice.as.mutation(api.accounts.connect, {
      session: { platform: "x", kind: "oauth", accessToken: "t" },
    });
    await expect(
      t.mutation(internal.ingest.upsertPosts, { accountId, posts: [post("x", 1)] }),
    ).rejects.toThrow("verifyIdentity");
    await expect(t.mutation(internal.accounts.recordSync, { accountId })).rejects.toThrow(
      "verifyIdentity",
    );
  });

  test("conversations and messages are upserted and scoped to their owner", async () => {
    const { t, signUp, connect } = await setup();
    const alice = await signUp();
    const bob = await signUp();
    const accountId = await connect(alice, "x");
    const sender = person("x", "bob");
    const message = (n: number) => ({
      id: `x:m${n}`,
      conversationId: "x:c1",
      sender,
      isMine: false,
      sentAt: new Date(Date.UTC(2026, 10, 1, n)).toISOString(),
      text: `m${n}`,
      media: [],
    });
    await t.mutation(internal.ingest.upsertConversations, {
      accountId,
      conversations: [
        { id: "x:c1", platform: "x", participants: [sender], updatedAt: "2026-11-01T02:00:00Z" },
        {
          id: "x:c2",
          platform: "x",
          participants: [sender],
          updatedAt: "2026-11-01T05:00:00Z",
          unavailable: { reason: "encrypted" },
        },
      ],
    });
    await t.mutation(internal.ingest.upsertMessages, { accountId, messages: [message(1), message(2)] });
    await t.mutation(internal.ingest.upsertMessages, { accountId, messages: [message(2)] });

    const conversations = await alice.as.query(api.conversations.list, page);
    expect(ids(conversations)).toEqual(["x:c2", "x:c1"]);
    expect(conversations.page[0].unreadCount).toBeUndefined();
    const messages = await alice.as.query(api.messages.list, { conversationId: "x:c1", ...page });
    expect(ids(messages)).toEqual(["x:m2", "x:m1"]);

    expect((await bob.as.query(api.conversations.list, page)).page).toEqual([]);
    await expect(
      bob.as.query(api.messages.list, { conversationId: "x:c1", ...page }),
    ).rejects.toThrow("Conversation not found");
  });
});

describe("feed", () => {
  async function seed() {
    const { t, signUp, connect } = await setup();
    const alice = await signUp();
    const x = await connect(alice, "x");
    const ig = await connect(alice, "instagram");
    const upsert = (accountId: Id<"connectedAccounts">, posts: PostInput[], caughtUp = true) =>
      t.mutation(internal.ingest.upsertPosts, {
        accountId,
        posts,
        page: { cursor: `after-${posts.at(-1)?.id}`, caughtUp },
      });
    return { t, signUp, connect, alice, x, ig, upsert };
  }

  test("merges platforms newest first and only shows the owner's posts", async () => {
    const { signUp, alice, x, ig, upsert } = await seed();
    await upsert(x, [post("x", 3), post("x", 1)]);
    await upsert(ig, [post("instagram", 4), post("instagram", 2)]);
    const result = await alice.as.query(api.feed.page, page);
    expect(ids(result)).toEqual(["instagram:4", "x:3", "instagram:2", "x:1"]);
    expect(result.caughtUp).toBe(true);
    const bob = await signUp();
    expect((await bob.as.query(api.feed.page, page)).page).toEqual([]);
  });

  test("filters posts below the relevance threshold and keeps unscored ones", async () => {
    const { alice, x, upsert } = await seed();
    await upsert(x, [
      post("x", 1),
      post("x", 2, { relevance: { score: RELEVANCE_THRESHOLD - 0.01, reasons: ["low"] } }),
      post("x", 3, { relevance: { score: RELEVANCE_THRESHOLD, reasons: ["follows"] } }),
      post("x", 4, { relevance: { score: 0.99, reasons: ["mutual"] } }),
    ]);
    expect(ids(await alice.as.query(api.feed.page, page))).toEqual(["x:4", "x:3", "x:1"]);
  });

  test("hides stories whose expiresAt has passed", async () => {
    const { alice, ig, upsert } = await seed();
    const hour = 60 * 60 * 1000;
    const at = (offset: number) => new Date(Date.now() + offset).toISOString();
    await upsert(ig, [
      post("instagram", 4, { format: "story", expiresAt: at(hour) }),
      post("instagram", 3, { format: "story", expiresAt: at(-hour) }),
      post("instagram", 2, { format: "post" }),
      post("instagram", 1),
    ]);
    expect(ids(await alice.as.query(api.feed.page, page))).toEqual([
      "instagram:4",
      "instagram:2",
      "instagram:1",
    ]);
  });

  test("ends at the caught-up point, per platform", async () => {
    const { t, alice, x, ig, upsert, connect } = await seed();
    await upsert(x, [post("x", 3), post("x", 1)]);
    await upsert(ig, [post("instagram", 2)]);
    await alice.as.mutation(api.feed.markCaughtUp, { until: Date.parse(post("x", 3).createdAt) });
    const caughtUp = await alice.as.query(api.feed.page, page);
    expect(caughtUp.page).toEqual([]);
    expect(caughtUp.isDone).toBe(true);

    await upsert(x, [post("x", 5)]);
    await upsert(ig, [post("instagram", 4)]);
    expect(ids(await alice.as.query(api.feed.page, page))).toEqual(["x:5", "instagram:4"]);

    // A platform connected after the caught-up point shows its posts in full.
    const youtube = await connect(alice, "youtube");
    await upsert(youtube, [post("youtube", 0)]);
    expect(ids(await alice.as.query(api.feed.page, page))).toEqual([
      "x:5",
      "instagram:4",
      "youtube:0",
    ]);
    expect(await t.run((ctx) => ctx.db.query("feedCursors").collect())).toHaveLength(3);
  });

  test("is not caught up while a connector is still paging, and keeps its older posts", async () => {
    const { alice, x, ig, upsert } = await seed();
    await upsert(x, [post("x", 5)], false);
    await upsert(ig, [post("instagram", 4)]);
    const first = await alice.as.query(api.feed.page, page);
    expect(first.isDone).toBe(true);
    expect(first.caughtUp).toBe(false);

    await alice.as.mutation(api.feed.markCaughtUp, { until: Date.parse(post("x", 5).createdAt) });
    await upsert(x, [post("x", 2)]);
    const second = await alice.as.query(api.feed.page, page);
    expect(ids(second)).toEqual(["x:5", "x:2"]);
    expect(second.caughtUp).toBe(true);
  });

  test("is not caught up before a connected platform has synced", async () => {
    const { signUp, connect } = await setup();
    const alice = await signUp();
    await connect(alice, "x");
    expect((await alice.as.query(api.feed.page, page)).caughtUp).toBe(false);
  });

  test("markCaughtUp never moves the caught-up point backwards", async () => {
    const { t, alice, x, ig, upsert } = await seed();
    await upsert(x, [post("x", 1)]);
    await upsert(ig, [post("instagram", 1)]);
    const nov2 = Date.parse("2026-11-02T00:00:00Z");
    await alice.as.mutation(api.feed.markCaughtUp, { until: nov2 });
    await alice.as.mutation(api.feed.markCaughtUp, { until: Date.parse("2026-11-01T00:00:00Z") });
    const cursors = await t.run((ctx) => ctx.db.query("feedCursors").collect());
    expect(cursors.map((c) => c.seenUntil)).toEqual([nov2, nov2]);
  });
});

describe("accounts", () => {
  test("connect accepts a device session holding only a deviceId", async () => {
    const { t, signUp } = await setup();
    const alice = await signUp();
    const accountId = await alice.as.mutation(api.accounts.connect, {
      session: { platform: "instagram", kind: "device", deviceId: "device-1" },
    });
    const account = await t.query(internal.accounts.get, { accountId });
    expect(account?.session).toEqual({ platform: "instagram", kind: "device", deviceId: "device-1" });
  });

  test("recordSync marks expired sessions and saveSession refreshes tokens", async () => {
    const { t, signUp, connect } = await setup();
    const alice = await signUp();
    const accountId = await connect(alice, "x");
    await t.mutation(internal.accounts.recordSync, {
      accountId,
      error: { kind: "session_expired" },
    });
    expect(await alice.as.query(api.accounts.list, {})).toMatchObject([
      { platform: "x", status: "expired", lastError: { kind: "session_expired" } },
    ]);
    await t.mutation(internal.accounts.saveSession, {
      accountId,
      session: { platform: "x", kind: "oauth", accessToken: "new" },
    });
    await t.mutation(internal.accounts.recordSync, { accountId });
    const account = await t.query(internal.accounts.get, { accountId });
    expect(account?.session).toMatchObject({ accessToken: "new" });
    expect(account?.status).toBe("active");
    await expect(
      t.mutation(internal.accounts.saveSession, {
        accountId,
        session: { platform: "instagram", kind: "cookies", cookies: [] },
      }),
    ).rejects.toThrow();
  });

  test("saveSession refuses a late refresh once the session was replaced", async () => {
    const { t, signUp, connect } = await setup();
    const alice = await signUp();
    const accountId = await connect(alice, "x");
    const read = await t.query(internal.accounts.get, { accountId });
    expect(read?.sessionVersion).toBe(1);

    // The user reconnects while a sync still holds the old session.
    await alice.as.mutation(api.accounts.connect, {
      session: { platform: "x", kind: "oauth", accessToken: "reconnected" },
    });
    const late = await t.mutation(internal.accounts.saveSession, {
      accountId,
      session: { platform: "x", kind: "oauth", accessToken: "late-refresh" },
      expectedVersion: read!.sessionVersion!,
    });
    expect(late).toEqual({ saved: false, reason: "session_changed", sessionVersion: 2 });
    expect((await t.query(internal.accounts.get, { accountId }))?.session).toMatchObject({
      accessToken: "reconnected",
    });

    const fresh = await t.mutation(internal.accounts.saveSession, {
      accountId,
      session: { platform: "x", kind: "oauth", accessToken: "refreshed" },
      expectedVersion: 2,
    });
    expect(fresh).toEqual({ saved: true, sessionVersion: 3 });
    // A second refresh racing from the same read loses too.
    expect(
      await t.mutation(internal.accounts.saveSession, {
        accountId,
        session: { platform: "x", kind: "oauth", accessToken: "racing" },
        expectedVersion: 2,
      }),
    ).toMatchObject({ saved: false });
    expect((await t.query(internal.accounts.get, { accountId }))?.session).toMatchObject({
      accessToken: "refreshed",
    });
  });

  async function seedContent(t: ReturnType<typeof convexTest>, accountId: Id<"connectedAccounts">, platform: string) {
    await t.mutation(internal.ingest.upsertPosts, {
      accountId,
      posts: [post(platform, 1), post(platform, 2)],
      page: { cursor: "c", caughtUp: true },
    });
    await t.mutation(internal.ingest.upsertConversations, {
      accountId,
      conversations: [
        { id: `${platform}:c`, platform, participants: [], updatedAt: "2026-11-01T00:00:00Z" },
      ],
    });
    await t.mutation(internal.ingest.upsertMessages, {
      accountId,
      messages: [
        {
          id: `${platform}:m`,
          conversationId: `${platform}:c`,
          sender: person(platform, "bob"),
          isMine: false,
          sentAt: "2026-11-01T00:00:00Z",
          text: "hi",
          media: [],
        },
      ],
    });
  }

  test("reconnecting the same identity keeps cursors and content", async () => {
    const { t, signUp, connect } = await setup();
    const alice = await signUp();
    const accountId = await connect(alice, "x");
    await seedContent(t, accountId, "x");
    await alice.as.mutation(api.feed.markCaughtUp, { until: Date.parse(post("x", 2).createdAt) });
    await connect(alice, "x");
    expect(await t.run((ctx) => ctx.db.query("posts").collect())).toHaveLength(2);
    expect(await t.run((ctx) => ctx.db.query("feedCursors").collect())).toMatchObject([
      { cursor: "c", seenUntil: Date.parse(post("x", 2).createdAt) },
    ]);
  });

  test("switching to another identity drops the old identity's cursor and content", async () => {
    const { t, signUp, connect } = await setup();
    const alice = await signUp();
    const accountId = await connect(alice, "x", "old");
    const igAccount = await connect(alice, "instagram");
    await seedContent(t, accountId, "x");
    await seedContent(t, igAccount, "instagram");

    await alice.as.mutation(api.accounts.connect, {
      session: { platform: "x", kind: "oauth", accessToken: "other" },
    });
    await t.mutation(internal.accounts.verifyIdentity, { accountId, me: person("x", "new") });
    expect((await t.query(internal.accounts.get, { accountId }))?.status).toBe("resetting");
    await expect(
      t.mutation(internal.ingest.upsertPosts, { accountId, posts: [post("x", 9)] }),
    ).rejects.toThrow("resetting");
    await t.finishAllScheduledFunctions(() => {});

    const account = await t.query(internal.accounts.get, { accountId });
    expect(account).toMatchObject({ status: "active", me: person("x", "new") });
    const remaining = await t.run(async (ctx) => ({
      posts: (await ctx.db.query("posts").collect()).map((p) => p.id),
      conversations: (await ctx.db.query("conversations").collect()).map((c) => c.id),
      messages: (await ctx.db.query("messages").collect()).map((m) => m.id),
      cursors: (await ctx.db.query("feedCursors").collect()).map((c) => c.platform),
    }));
    expect(remaining).toEqual({
      posts: ["instagram:1", "instagram:2"],
      conversations: ["instagram:c"],
      messages: ["instagram:m"],
      cursors: ["instagram"],
    });
  });

  test("disconnect removes the account, its cursor and its content", async () => {
    const { t, signUp, connect } = await setup();
    const alice = await signUp();
    const accountId = await connect(alice, "x");
    await seedContent(t, accountId, "x");
    await alice.as.mutation(api.accounts.disconnect, { platform: "x" });
    await t.finishAllScheduledFunctions(() => {});
    expect(await alice.as.query(api.accounts.list, {})).toEqual([]);
    const counts = await t.run(async (ctx) => [
      (await ctx.db.query("posts").collect()).length,
      (await ctx.db.query("conversations").collect()).length,
      (await ctx.db.query("messages").collect()).length,
      (await ctx.db.query("feedCursors").collect()).length,
    ]);
    expect(counts).toEqual([0, 0, 0, 0]);
  });
});

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("titles", () => {
  test("keeps real titles, drops empty ones and the author's name, and feed.page returns them", async () => {
    const { t, signUp, connect } = await setup();
    const alice = await signUp();
    const accountId = await connect(alice, "x");
    await t.mutation(internal.ingest.upsertPosts, {
      accountId,
      posts: [
        post("x", 5, { title: "  How we built it  " }),
        post("x", 4, { title: "author" }),
        post("x", 3, { title: "@Author" }),
        post("x", 2, { title: "   " }),
        post("x", 1),
      ],
    });
    const feed = await alice.as.query(api.feed.page, page);
    expect(feed.page.map((p) => [p.id, p.title])).toEqual([
      ["x:5", "How we built it"],
      ["x:4", undefined],
      ["x:3", undefined],
      ["x:2", undefined],
      ["x:1", undefined],
    ]);
  });
});

describe("timestamps", () => {
  test("posts store epoch ms, keep fetchedAt and move updatedAt on re-ingest", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-10T00:00:00Z"));
    const { t, signUp, connect } = await setup();
    const alice = await signUp();
    const accountId = await connect(alice, "x");
    // String order would put +05:00 (05:00Z) after 06:00Z; numbers sort right.
    await t.mutation(internal.ingest.upsertPosts, {
      accountId,
      posts: [
        post("x", 1, { createdAt: "2026-11-01T10:00:00+05:00" }),
        post("x", 2, { createdAt: "2026-11-01T06:00:00Z" }),
      ],
    });
    vi.setSystemTime(Date.parse("2026-11-11T00:00:00Z"));
    await t.mutation(internal.ingest.upsertPosts, { accountId, posts: [post("x", 1, { createdAt: "2026-11-01T05:00:00Z" })] });
    const feed = await alice.as.query(api.feed.page, page);
    expect(feed.page.map((p) => [p.id, p.createdAt])).toEqual([
      ["x:2", Date.parse("2026-11-01T06:00:00Z")],
      ["x:1", Date.parse("2026-11-01T05:00:00Z")],
    ]);
    // convex-test nudges the clock forward by a few ms per transaction.
    const { fetchedAt, updatedAt } = feed.page[1];
    expect(fetchedAt - Date.parse("2026-11-10T00:00:00Z")).toBeLessThan(1000);
    expect(updatedAt - Date.parse("2026-11-11T00:00:00Z")).toBeLessThan(1000);
    expect(updatedAt).toBeGreaterThanOrEqual(Date.parse("2026-11-11T00:00:00Z"));
    await expect(
      t.mutation(internal.ingest.upsertPosts, { accountId, posts: [post("x", 3, { createdAt: "yesterday" })] }),
    ).rejects.toThrow("Invalid ISO date");
  });

  test("conversations and messages store and sort by epoch ms", async () => {
    const { t, signUp, connect } = await setup();
    const alice = await signUp();
    const accountId = await connect(alice, "x");
    const sender = person("x", "bob");
    const message = (n: number, sentAt: string) => ({
      id: `x:m${n}`, conversationId: "x:c1", sender, isMine: false, sentAt, text: "", media: [],
    });
    await t.mutation(internal.ingest.upsertConversations, {
      accountId,
      conversations: [
        { id: "x:c1", platform: "x", participants: [sender], updatedAt: "2026-11-01T10:00:00+05:00", lastMessage: message(1, "2026-11-01T10:00:00+05:00") },
        { id: "x:c2", platform: "x", participants: [sender], updatedAt: "2026-11-01T06:00:00Z" },
      ],
    });
    await t.mutation(internal.ingest.upsertMessages, {
      accountId,
      messages: [message(1, "2026-11-01T10:00:00+05:00"), message(2, "2026-11-01T06:00:00Z")],
    });
    const conversations = await alice.as.query(api.conversations.list, page);
    expect(conversations.page.map((c) => [c.id, c.updatedAt])).toEqual([
      ["x:c2", Date.parse("2026-11-01T06:00:00Z")],
      ["x:c1", Date.parse("2026-11-01T05:00:00Z")],
    ]);
    expect(conversations.page[1].lastMessage?.sentAt).toBe(Date.parse("2026-11-01T05:00:00Z"));
    const messages = await alice.as.query(api.messages.list, { conversationId: "x:c1", ...page });
    expect(messages.page.map((m) => [m.id, m.sentAt])).toEqual([
      ["x:m2", Date.parse("2026-11-01T06:00:00Z")],
      ["x:m1", Date.parse("2026-11-01T05:00:00Z")],
    ]);
  });
});

describe("media persistence", () => {
  const image = (url: string, extra = {}) => ({ kind: "image" as const, url, ...extra });
  const avatarAuthor = (platform: string, avatarUrl: string) => ({ ...person(platform, "author"), avatarUrl });

  function stubFetch(fail: string[] = []) {
    const fetch = vi.fn(async (url: string) =>
      fail.some((f) => url.startsWith(f))
        ? new Response("gone", { status: 403 })
        : new Response(new Blob([`bytes of ${url}`], { type: "image/jpeg" })),
    );
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  const files = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length);

  test("copies Instagram media and avatars into storage, and the feed prefers the copy", async () => {
    const fetch = stubFetch(["https://cdn.ig/broken"]);
    const { t, signUp, connect } = await setup();
    const alice = await signUp();
    const accountId = await connect(alice, "instagram");
    await t.mutation(internal.ingest.upsertPosts, {
      accountId,
      posts: [
        post("instagram", 1, {
          author: avatarAuthor("instagram", "https://cdn.ig/avatar.jpg?sig=1"),
          media: [image("https://cdn.ig/a.jpg?sig=1"), image("https://cdn.ig/broken.jpg")],
        }),
      ],
    });
    await t.finishAllScheduledFunctions(() => {});
    expect(fetch).toHaveBeenCalledTimes(3);
    const [row] = await t.run((ctx) => ctx.db.query("posts").collect());
    expect(row.author.avatarStorageId).toBeDefined();
    expect(row.media[0].storageId).toBeDefined();
    expect(row.media[1].storageId).toBeUndefined();

    const [item] = (await alice.as.query(api.feed.page, page)).page;
    const stored = await t.run(async (ctx) => [
      await ctx.storage.getUrl(row.author.avatarStorageId!),
      await ctx.storage.getUrl(row.media[0].storageId!),
    ]);
    expect(item.author.avatarUrl).toBe(stored[0]);
    expect(item.media.map((m) => m.url)).toEqual([stored[1], "https://cdn.ig/broken.jpg"]);
    expect(item.media[0]).not.toHaveProperty("storageId");
    expect(item.author).not.toHaveProperty("avatarStorageId");

    // A re-sync with a fresh signature keeps the copy; a replaced image drops it.
    await t.mutation(internal.ingest.upsertPosts, {
      accountId,
      posts: [
        post("instagram", 1, {
          author: avatarAuthor("instagram", "https://cdn.ig/avatar.jpg?sig=2"),
          media: [image("https://cdn.ig/a.jpg?sig=2")],
        }),
      ],
    });
    await t.finishAllScheduledFunctions(() => {});
    const [again] = await t.run((ctx) => ctx.db.query("posts").collect());
    expect(again.media[0].storageId).toBe(row.media[0].storageId);
    expect(again.author.avatarStorageId).toBe(row.author.avatarStorageId);
    expect(fetch).toHaveBeenCalledTimes(3);

    await t.mutation(internal.ingest.upsertPosts, {
      accountId,
      posts: [post("instagram", 1, { media: [image("https://cdn.ig/b.jpg")] })],
    });
    await t.finishAllScheduledFunctions(() => {});
    const [replaced] = await t.run((ctx) => ctx.db.query("posts").collect());
    expect(replaced.media[0].storageId).not.toBe(row.media[0].storageId);
    expect(await files(t)).toBe(1);
  });

  test("X media is never copied", async () => {
    const fetch = stubFetch();
    const { t, signUp, connect } = await setup();
    const alice = await signUp();
    const accountId = await connect(alice, "x");
    await t.mutation(internal.ingest.upsertPosts, {
      accountId,
      posts: [post("x", 1, { author: avatarAuthor("x", "https://pbs.x/a.jpg"), media: [image("https://pbs.x/m.jpg")] })],
    });
    await t.finishAllScheduledFunctions(() => {});
    expect(fetch).not.toHaveBeenCalled();
    expect(await files(t)).toBe(0);
    const [item] = (await alice.as.query(api.feed.page, page)).page;
    expect(item.media[0].url).toBe("https://pbs.x/m.jpg");
    expect(item.author.avatarUrl).toBe("https://pbs.x/a.jpg");
  });

  test("a copy that finishes after its post was deleted is discarded", async () => {
    stubFetch();
    const { t, signUp, connect } = await setup();
    const alice = await signUp();
    const accountId = await connect(alice, "instagram");
    await t.mutation(internal.ingest.upsertPosts, {
      accountId,
      posts: [post("instagram", 1, { media: [image("https://cdn.ig/a.jpg")] })],
    });
    const [row] = await t.run((ctx) => ctx.db.query("posts").collect());
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x"])));
    await t.run((ctx) => ctx.db.delete(row._id));
    await t.mutation(internal.media.attach, { postId: row._id, media: [{ url: "https://cdn.ig/a.jpg", storageId }] });
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).toBeNull();
  });
});

describe("layout metadata", () => {
  test("keeps width, height and blurhash through ingest and media copies", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Blob(["img"])));
    const { t, signUp, connect } = await setup();
    const alice = await signUp();
    const accountId = await connect(alice, "instagram");
    const media = [
      { kind: "image" as const, url: "https://cdn.ig/a.jpg", width: 1080, height: 1350, blurhash: "LEHV6nWB2yk8" },
      { kind: "video" as const, url: "https://cdn.ig/v.mp4", durationSec: 12 },
    ];
    await t.mutation(internal.ingest.upsertPosts, { accountId, posts: [post("instagram", 1, { media })] });
    await t.finishAllScheduledFunctions(() => {});
    const [item] = (await alice.as.query(api.feed.page, page)).page;
    expect(item.media[0]).toMatchObject({ width: 1080, height: 1350, blurhash: "LEHV6nWB2yk8" });
    expect(item.media[1]).toMatchObject({ kind: "video", durationSec: 12 });
    expect(item.media[1]).not.toHaveProperty("width");
  });
});

describe("post states", () => {
  async function seedPosts() {
    const { t, signUp, connect } = await setup();
    const alice = await signUp();
    const bob = await signUp();
    const accountId = await connect(alice, "x");
    await t.mutation(internal.ingest.upsertPosts, { accountId, posts: [post("x", 2), post("x", 1)] });
    const rows = await t.run((ctx) => ctx.db.query("posts").collect());
    const postId = (id: string) => rows.find((r) => r.id === id)!._id;
    return { t, alice, bob, postId };
  }

  test("marks seen, opened, hidden and saved, and the feed leaves hidden posts out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    const { t, alice, postId } = await seedPosts();
    const x1 = postId("x:1");
    await alice.as.mutation(api.postStates.markSeen, { postId: x1 });
    await alice.as.mutation(api.postStates.markOpened, { postId: x1 });
    await alice.as.mutation(api.postStates.setSaved, { postId: x1, saved: true });
    vi.setSystemTime(2_000);
    await alice.as.mutation(api.postStates.markSeen, { postId: x1 });
    await alice.as.mutation(api.postStates.markOpened, { postId: x1 });
    await alice.as.mutation(api.postStates.setHidden, { postId: x1, hidden: true });
    const states = await t.run((ctx) => ctx.db.query("postStates").collect());
    expect(states).toHaveLength(1);
    // convex-test nudges the clock forward by a few ms per transaction.
    const { seenAt, openedAt, savedAt, hiddenAt } = states[0];
    expect([seenAt, savedAt].every((at) => at! >= 1_000 && at! < 2_000)).toBe(true);
    expect([openedAt, hiddenAt].every((at) => at! >= 2_000)).toBe(true);
    expect(ids(await alice.as.query(api.feed.page, page))).toEqual(["x:2"]);

    await alice.as.mutation(api.postStates.setHidden, { postId: x1, hidden: false });
    await alice.as.mutation(api.postStates.setSaved, { postId: x1, saved: false });
    expect(ids(await alice.as.query(api.feed.page, page))).toEqual(["x:2", "x:1"]);
    const [cleared] = await t.run((ctx) => ctx.db.query("postStates").collect());
    expect(cleared.hiddenAt).toBeUndefined();
    expect(cleared.savedAt).toBeUndefined();
  });

  test("only the post's owner can change its state", async () => {
    const { t, bob, postId } = await seedPosts();
    const x1 = postId("x:1");
    await expect(t.mutation(api.postStates.markSeen, { postId: x1 })).rejects.toThrow("Not signed in");
    for (const call of [
      bob.as.mutation(api.postStates.markSeen, { postId: x1 }),
      bob.as.mutation(api.postStates.markOpened, { postId: x1 }),
      bob.as.mutation(api.postStates.setHidden, { postId: x1, hidden: true }),
      bob.as.mutation(api.postStates.setSaved, { postId: x1, saved: true }),
    ]) {
      await expect(call).rejects.toThrow("Post not found");
    }
    expect(await t.run((ctx) => ctx.db.query("postStates").collect())).toEqual([]);
  });
});

describe("retention", () => {
  test("is registered in the shared cron registry as app:retention, daily", () => {
    expect((crons as unknown as { crons: Record<string, { schedule: { type: string } }> }).crons["app:retention"]).toMatchObject({
      name: "retention:run",
      schedule: { type: "daily" },
    });
  });

  test("deletes unsaved posts past the window and expired stories, with their files and states", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Blob(["img"])));
    const { t, signUp, connect } = await setup();
    const alice = await signUp();
    const accountId = await connect(alice, "instagram");
    const now = Date.now();
    const old = iso(now - (RETENTION_DAYS + 1) * DAY);
    const media = (n: number) => [{ kind: "image" as const, url: `https://cdn.ig/${n}.jpg` }];
    await t.mutation(internal.ingest.upsertPosts, {
      accountId,
      posts: [
        post("instagram", 1, { createdAt: old, media: media(1) }),
        post("instagram", 2, { createdAt: old, media: media(2) }),
        post("instagram", 3, { createdAt: iso(now - (RETENTION_DAYS - 1) * DAY), media: media(3) }),
        post("instagram", 4, { createdAt: iso(now - DAY), format: "story", expiresAt: iso(now - 1000), media: media(4) }),
        post("instagram", 5, { createdAt: iso(now - DAY), format: "story", expiresAt: iso(now + DAY) }),
      ],
    });
    await t.finishAllScheduledFunctions(() => {});
    const rows = await t.run((ctx) => ctx.db.query("posts").collect());
    const postId = (id: string) => rows.find((r) => r.id === id)!._id;
    await alice.as.mutation(api.postStates.setSaved, { postId: postId("instagram:2"), saved: true });
    await alice.as.mutation(api.postStates.markSeen, { postId: postId("instagram:1") });
    await alice.as.mutation(api.postStates.markSeen, { postId: postId("instagram:4") });
    expect(await t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length)).toBe(4);

    await t.mutation(internal.retention.run, {});
    await t.finishAllScheduledFunctions(() => {});

    const left = await t.run(async (ctx) => ({
      posts: (await ctx.db.query("posts").collect()).map((p) => p.id).sort(),
      states: (await ctx.db.query("postStates").collect()).length,
      files: (await ctx.db.system.query("_storage").collect()).length,
    }));
    expect(left).toEqual({ posts: ["instagram:2", "instagram:3", "instagram:5"], states: 1, files: 2 });
  });
});

describe("limits", () => {
  test("caps post text at ingest", async () => {
    const { t, signUp, connect } = await setup();
    const accountId = await connect(await signUp(), "x");
    await t.mutation(internal.ingest.upsertPosts, {
      accountId,
      posts: [post("x", 1, { text: "a".repeat(MAX_TEXT_LENGTH + 500), quoted: post("x", 0, { text: "b".repeat(MAX_TEXT_LENGTH * 2) }) })],
    });
    const [row] = await t.run((ctx) => ctx.db.query("posts").collect());
    expect(MAX_TEXT_LENGTH).toBe(10_000);
    expect(row.text).toHaveLength(MAX_TEXT_LENGTH);
    expect(row.quoted?.text).toHaveLength(MAX_TEXT_LENGTH);
  });

  test("never stores engagement counts", async () => {
    const { t, signUp, connect } = await setup();
    const accountId = await connect(await signUp(), "x");
    await expect(
      t.mutation(internal.ingest.upsertPosts, {
        accountId,
        posts: [{ ...post("x", 1), likeCount: 12 } as PostInput],
      }),
    ).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("posts").collect())).toEqual([]);
  });
});
