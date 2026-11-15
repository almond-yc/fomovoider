/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { RELEVANCE_THRESHOLD } from "./feed";
import schema from "./schema";
import type { PostInput } from "./lib/validators";

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
      t.mutation(api.feed.markCaughtUp, { until: "2026-11-01T00:00:00Z" }),
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
    expect(rows[0].createdAt).toBe("2026-11-01T01:00:00.000Z");
    expect(rows[0]).not.toHaveProperty("raw");
    const cursors = await t.run((ctx) => ctx.db.query("feedCursors").collect());
    expect(cursors).toMatchObject([{ platform: "x", cursor: "c1", caughtUp: true }]);
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

  test("ends at the caught-up point, per platform", async () => {
    const { t, alice, x, ig, upsert, connect } = await seed();
    await upsert(x, [post("x", 3), post("x", 1)]);
    await upsert(ig, [post("instagram", 2)]);
    await alice.as.mutation(api.feed.markCaughtUp, { until: post("x", 3).createdAt });
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

    await alice.as.mutation(api.feed.markCaughtUp, { until: post("x", 5).createdAt });
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
    await alice.as.mutation(api.feed.markCaughtUp, { until: "2026-11-02T00:00:00Z" });
    await alice.as.mutation(api.feed.markCaughtUp, { until: "2026-11-01T00:00:00Z" });
    const cursors = await t.run((ctx) => ctx.db.query("feedCursors").collect());
    expect(cursors.map((c) => c.seenUntil)).toEqual([
      "2026-11-02T00:00:00.000Z",
      "2026-11-02T00:00:00.000Z",
    ]);
  });
});

describe("accounts", () => {
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
    await alice.as.mutation(api.feed.markCaughtUp, { until: post("x", 2).createdAt });
    await connect(alice, "x");
    expect(await t.run((ctx) => ctx.db.query("posts").collect())).toHaveLength(2);
    expect(await t.run((ctx) => ctx.db.query("feedCursors").collect())).toMatchObject([
      { cursor: "c", seenUntil: post("x", 2).createdAt },
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
