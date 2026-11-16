/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const as = t.withIdentity({ subject: `${userId}|session` });
  const connect = async (platform: string) => {
    const accountId = await as.mutation(api.accounts.connect, {
      session: { platform, kind: "oauth", accessToken: `token-${platform}` },
    });
    return accountId;
  };
  const verify = (accountId: Awaited<ReturnType<typeof connect>>, platform: string) =>
    t.mutation(internal.accounts.verifyIdentity, {
      accountId,
      me: { id: `${platform}:me`, platform, handle: "me", displayName: "me" },
    });
  return { t, userId, as, connect, verify };
}

describe("syncStatus.status", () => {
  test("a pending account is still syncing its feed and chats", async () => {
    const { as, connect } = await setup();
    await connect("x");
    expect(await as.query(api.syncStatus.status, {})).toEqual({ feed: ["x"], chats: ["x"] });
  });

  test("follows the feed cursor and the X DM pass until both are done", async () => {
    const { t, as, connect, verify } = await setup();
    const accountId = await connect("x");
    await verify(accountId, "x");
    await t.mutation(internal.ingest.upsertPosts, { accountId, posts: [], page: { cursor: "c1", caughtUp: false } });
    await t.mutation(internal.x.state.saveState, { accountId, xUserId: "x:me", patch: { dmCursor: "d1" } });
    expect(await as.query(api.syncStatus.status, {})).toEqual({ feed: ["x"], chats: ["x"] });

    await t.mutation(internal.ingest.upsertPosts, { accountId, posts: [], page: { cursor: "c2", caughtUp: true } });
    await t.mutation(internal.x.state.saveState, { accountId, xUserId: "x:me", patch: {}, endDmPass: true });
    expect(await as.query(api.syncStatus.status, {})).toEqual({ feed: [], chats: ["x"] });

    // The X Chat listing runs on its own; an empty one still finishes the sync.
    await t.mutation(internal.x.state.saveState, { accountId, xUserId: "x:me", patch: {}, endChatPass: true });
    expect(await as.query(api.syncStatus.status, {})).toEqual({ feed: [], chats: [] });
  });

  test("a row from before the pass flags counts as synced unless a pass is cut short", async () => {
    const { t, userId, as, connect, verify } = await setup();
    const accountId = await connect("x");
    await verify(accountId, "x");
    await t.mutation(internal.ingest.upsertPosts, { accountId, posts: [], page: { cursor: "c", caughtUp: true } });
    const stateId = await t.run((ctx) =>
      ctx.db.insert("x_sync_state", { accountId, xUserId: "x:me", dmSinceId: "x:1", chatSince: "2026-11-01T00:00:00Z" }),
    );
    expect(await as.query(api.syncStatus.status, {})).toEqual({ feed: [], chats: [] });

    // A later DM pass finishing doesn't make it wait for the X Chat listing.
    await t.mutation(internal.x.state.saveState, { accountId, xUserId: "x:me", patch: {}, endDmPass: true });
    expect(await as.query(api.syncStatus.status, {})).toEqual({ feed: [], chats: [] });

    await t.run((ctx) => ctx.db.patch(stateId, { chatCursor: "next" }));
    expect(await as.query(api.syncStatus.status, {})).toEqual({ feed: [], chats: ["x"] });
    void userId;
  });

  test("an unfinished X Chat history fetch keeps chats syncing", async () => {
    const { t, userId, as, connect, verify } = await setup();
    const accountId = await connect("x");
    await verify(accountId, "x");
    await t.mutation(internal.ingest.upsertPosts, { accountId, posts: [], page: { cursor: "c", caughtUp: true } });
    await t.mutation(internal.x.state.saveState, { accountId, xUserId: "x:me", patch: {}, endDmPass: true, endChatPass: true });
    expect(await as.query(api.syncStatus.status, {})).toEqual({ feed: [], chats: [] });
    await t.run((ctx) =>
      ctx.db.insert("x_chat_cursors", { userId, xUserId: "x:me", conversationId: "x:1", cursor: "next" }),
    );
    expect(await as.query(api.syncStatus.status, {})).toEqual({ feed: [], chats: ["x"] });
  });

  test("expired and failing accounts are not shown as syncing", async () => {
    const { t, as, connect, verify } = await setup();
    const accountId = await connect("x");
    await verify(accountId, "x");
    await t.run((ctx) => ctx.db.patch(accountId, { status: "expired" }));
    expect(await as.query(api.syncStatus.status, {})).toEqual({ feed: [], chats: [] });
  });

  test("Instagram chats sync until the web view has loaded the inbox for this identity", async () => {
    const { t, userId, as, connect, verify } = await setup();
    const accountId = await connect("instagram");
    await verify(accountId, "instagram");
    await t.mutation(internal.ingest.upsertPosts, { accountId, posts: [], page: { cursor: "r", caughtUp: true } });
    await t.run((ctx) =>
      ctx.db.insert("instagram_devices", {
        userId,
        accountId,
        name: "Fomovoider app",
        timezone: "America/Los_Angeles",
        scheduleEnabled: true,
        transport: "webview",
      }),
    );
    expect(await as.query(api.syncStatus.status, {})).toEqual({ feed: [], chats: ["instagram"] });
    // An inbox load started (dms:startSync); an empty inbox submits nothing.
    const stateId = await t.run((ctx) => ctx.db.insert("instagram_dmState", { userId, viewerIds: [], lastSyncAt: 1 }));
    expect(await as.query(api.syncStatus.status, {})).toEqual({ feed: [], chats: [] });
    // Read as another Instagram identity: this one's inbox hasn't loaded.
    await t.run((ctx) => ctx.db.patch(stateId, { meId: "instagram:someone-else" }));
    expect(await as.query(api.syncStatus.status, {})).toEqual({ feed: [], chats: ["instagram"] });
    await t.run((ctx) => ctx.db.patch(stateId, { meId: "instagram:me" }));
    expect(await as.query(api.syncStatus.status, {})).toEqual({ feed: [], chats: [] });
  });
});
