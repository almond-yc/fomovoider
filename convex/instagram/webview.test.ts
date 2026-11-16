/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { sha256Hex } from "./common";

const modules = import.meta.glob("/convex/**/*.ts");
const me = { id: "instagram:nico", platform: "instagram", handle: "nico", displayName: "Nico" };

async function signedIn() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const as = t.withIdentity({ subject: `${userId}|session` });
  return { t, userId, as };
}

async function connected() {
  const s = await signedIn();
  expect(await s.as.mutation(api.instagram.webview.connect, { me })).toEqual({ status: "active" });
  return s;
}

async function started(as: Awaited<ReturnType<typeof signedIn>>["as"], trigger: "open" | "background" | "manual" = "open") {
  const run = await as.mutation(api.instagram.webview.startRefresh, { trigger });
  if (run.kind !== "run") throw new Error(`expected a run, got ${JSON.stringify(run)}`);
  return run;
}

function item(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    author: { id: "instagram:alice", platform: "instagram", handle: "alice", displayName: "Alice" },
    createdAt: "2026-11-15T10:00:00.000Z",
    text: "hello",
    permalink: "https://www.instagram.com/p/abc/",
    format: "post" as const,
    media: [{ kind: "image" as const, url: "https://scontent.cdninstagram.com/a.jpg?oe=1" }],
    facts: { sponsored: false, suggested: false, isReel: false, followsAuthor: true },
    ...extra,
  };
}

describe("instagram web view", () => {
  test("connect makes a webview device session and confirms the identity", async () => {
    const { t, userId, as } = await connected();
    const account = await t.run((ctx) =>
      ctx.db
        .query("connectedAccounts")
        .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId).eq("platform", "instagram"))
        .unique(),
    );
    expect(account?.session.kind).toBe("device");
    expect(account?.me?.handle).toBe("nico");
    expect(await as.query(api.instagram.webview.state, {})).toMatchObject({ connected: true, killSwitch: false });
    expect((await as.query(api.instagram.devices.status, {}))?.paired).toBe(true);
    // Reconnecting with the same identity keeps the account active.
    expect(await as.mutation(api.instagram.webview.connect, { me })).toEqual({ status: "active" });
  });

  test("a refresh streams items with uploads, saves the feed cursor and spaces the next one", async () => {
    const { t, userId, as } = await connected();
    const run = await started(as);
    expect(run.budget).toEqual({ maxMs: 240_000, maxPosts: 60, maxStoryFrames: 40 });
    expect(run.cursors).toEqual({});

    const uploadUrl = await as.mutation(api.instagram.webview.generateUploadUrl, { runId: run.runId });
    expect(typeof uploadUrl).toBe("string");
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["jpeg"])));
    const count = await as.mutation(api.instagram.webview.submit, {
      runId: run.runId,
      items: [
        item("instagram:1", {
          media: [{ kind: "image", url: "https://scontent.cdninstagram.com/a.jpg?oe=1", storageId, width: 1080 }],
          extracted: { place: { name: "Berkeley", lat: 37.87, lng: -122.27 } },
        }),
        item("instagram:2", { facts: { sponsored: true, suggested: false, isReel: true, paidPartnership: true } }),
        item("instagram:3", {
          format: "story",
          expiresAt: "2026-11-16T10:00:00.000Z",
          facts: { sponsored: false, suggested: false, isReel: false, storyTrayPosition: 2 },
        }),
      ],
      feedPage: { variant: "following", endCursor: "cursor-2", hasNextPage: true, newestId: "instagram:1" },
    });
    expect(count).toBe(3);
    const posts = await t.run((ctx) => ctx.db.query("posts").collect());
    const first = posts.find((p) => p.id === "instagram:1")!;
    expect(first.media[0].storageId).toBe(storageId);
    expect(first.extracted?.place?.name).toBe("Berkeley");
    expect(posts.find((p) => p.id === "instagram:3")?.format).toBe("story");
    expect(posts.find((p) => p.id === "instagram:2")).toMatchObject({ sponsored: true, suggested: false });
    expect(first).toMatchObject({ sponsored: false, suggested: false });
    const feed = await as.query(api.feed.page, { paginationOpts: { numItems: 10, cursor: null } });
    expect(feed.page.find((p: { id: string }) => p.id === "instagram:2")).toMatchObject({ sponsored: true });
    const facts = await t.run((ctx) => ctx.db.query("instagram_postFacts").collect());
    expect(facts.find((f) => f.postId === "instagram:2")).toMatchObject({ sponsored: true, isReel: true, paidPartnership: true });

    await as.mutation(api.instagram.webview.finish, {
      runId: run.runId,
      stats: { posts: 3, storyFrames: 1, durationMs: 60_000 },
      caughtUp: true,
    });
    const cursor = await t.run((ctx) => ctx.db.query("feedCursors").collect());
    expect(cursor).toMatchObject([{ userId, platform: "instagram", caughtUp: true }]);

    const next = await as.mutation(api.instagram.webview.startRefresh, { trigger: "open" });
    expect(next).toMatchObject({ kind: "wait", reason: "too_soon" });
    await t.run(async (ctx) => {
      await ctx.db.patch(run.runId, { claimedAt: Date.now() - 11 * 60_000, scheduledFor: Date.now() - 11 * 60_000 });
    });
    expect(await as.mutation(api.instagram.webview.startRefresh, { trigger: "background" })).toMatchObject({
      kind: "wait",
      reason: "too_soon",
    });
    const again = await started(as, "open");
    expect(again.cursors.following).toEqual({ endCursor: "cursor-2", hasNextPage: true, newestId: "instagram:1" });
    expect(again.knownIds.sort()).toEqual(["instagram:1", "instagram:2", "instagram:3"]);
  });

  test("only one refresh runs at a time, and only for its owner", async () => {
    const { t, as } = await connected();
    const run = await started(as);
    expect(await as.mutation(api.instagram.webview.startRefresh, { trigger: "open" })).toMatchObject({
      kind: "wait",
      reason: "busy",
    });
    const otherId = await t.run((ctx) => ctx.db.insert("users", {}));
    const other = t.withIdentity({ subject: `${otherId}|session` });
    await expect(
      other.mutation(api.instagram.webview.submit, { runId: run.runId, items: [item("instagram:x")] }),
    ).rejects.toThrow("Run not found");
    expect(await other.mutation(api.instagram.webview.startRefresh, { trigger: "open" })).toMatchObject({
      kind: "blocked",
      reason: "not_connected",
    });
  });

  test("the kill switch stops web-view refreshes, the host agent and scheduling", async () => {
    const { t, as } = await connected();
    const run = await started(as);
    await t.mutation(internal.instagram.killSwitch.set, { enabled: true, reason: "checkpoint" });
    expect(await as.query(api.instagram.webview.state, {})).toMatchObject({ killSwitch: true });
    await expect(
      as.mutation(api.instagram.webview.submit, { runId: run.runId, items: [item("instagram:1")] }),
    ).rejects.toThrow("kill switch");
    await as.mutation(api.instagram.webview.finish, {
      runId: run.runId,
      stats: { posts: 0, storyFrames: 0, durationMs: 1000 },
      error: "kill switch",
    });
    expect(await as.mutation(api.instagram.webview.startRefresh, { trigger: "manual" })).toMatchObject({
      kind: "blocked",
      reason: "kill_switch",
      detail: "checkpoint",
    });
    expect(await t.mutation(internal.instagram.schedule.planDay, {})).toBe(0);

    await t.mutation(internal.instagram.killSwitch.set, { enabled: false });
    await t.run(async (ctx) => {
      await ctx.db.patch(run.runId, { claimedAt: 0, scheduledFor: 0 });
    });
    await started(as, "manual");
  });

  test("a tripwire pauses the device for 72 hours", async () => {
    const { as } = await connected();
    const run = await started(as);
    await as.mutation(api.instagram.webview.finish, {
      runId: run.runId,
      stats: { posts: 0, storyFrames: 0, durationMs: 1000 },
      tripwire: { kind: "challenge", screenText: "https://www.instagram.com/challenge/" },
    });
    const blocked = await as.mutation(api.instagram.webview.startRefresh, { trigger: "manual" });
    expect(blocked).toMatchObject({ kind: "blocked", reason: "paused" });
    if (blocked.kind === "blocked") expect(blocked.until! - Date.now()).toBeGreaterThan(71 * 3_600_000);
  });

  test("Run now from the app is picked up by the web view", async () => {
    const { t, as } = await connected();
    const queued = await as.mutation(api.instagram.devices.runNow, {});
    const run = await started(as, "background");
    expect(run.runId).toBe(queued);
    expect(run.trigger).toBe("manual");
    const row = await t.run((ctx) => ctx.db.get(queued));
    expect(row?.state).toBe("claimed");
  });

  test("switching drivers revokes the other one and ends its runs", async () => {
    const { t, userId, as } = await signedIn();
    const { code } = await t.mutation(internal.instagram.devices.pairForUser, { userId });
    await t.mutation(api.instagram.agent.redeemPairing, { code, tokenHash: await sha256Hex("agent-token") });
    const agentRun = await t.mutation(internal.instagram.devices.runNowForUser, { userId });

    await as.mutation(api.instagram.webview.connect, { me });
    expect(await t.run((ctx) => ctx.db.get(agentRun))).toMatchObject({ state: "skipped" });
    await expect(t.mutation(api.instagram.agent.claimRun, { token: "agent-token" })).rejects.toThrow("Unknown device token");
    const webRun = await started(as, "manual");

    const again = await t.mutation(internal.instagram.devices.pairForUser, { userId });
    await t.mutation(api.instagram.agent.redeemPairing, { code: again.code, tokenHash: await sha256Hex("agent-token") });
    expect(await t.run((ctx) => ctx.db.get(webRun.runId))).toMatchObject({ state: "failed" });
    expect(await as.mutation(api.instagram.webview.startRefresh, { trigger: "manual" })).toMatchObject({
      kind: "blocked",
      reason: "not_connected",
    });
  });

  test("logging in again lifts a login pause but not a challenge pause", async () => {
    const { t, as } = await connected();
    const trip = async (kind: "login" | "challenge") => {
      const run = await started(as, "manual");
      await as.mutation(api.instagram.webview.finish, {
        runId: run.runId,
        stats: { posts: 0, storyFrames: 0, durationMs: 1000 },
        tripwire: { kind, screenText: "https://www.instagram.com/accounts/login/" },
      });
      await t.run(async (ctx) => {
        await ctx.db.patch(run.runId, { claimedAt: 0, scheduledFor: 0 });
      });
      await as.mutation(api.instagram.webview.connect, { me });
      return (await as.query(api.instagram.webview.state, {})).pausedUntil;
    };
    expect(await trip("login")).toBeUndefined();
    expect(await trip("challenge")).toBeGreaterThan(Date.now());
  });

  test("the stories cursor keeps the latest reel fetched", async () => {
    const { t, as } = await connected();
    const run = await started(as);
    await as.mutation(api.instagram.webview.submit, {
      runId: run.runId,
      items: [],
      feedPage: { variant: "stories", hasNextPage: false, newestAt: 1_794_779_564_000 },
    });
    await as.mutation(api.instagram.webview.finish, { runId: run.runId, stats: { posts: 0, storyFrames: 0, durationMs: 1 } });
    await t.run(async (ctx) => {
      await ctx.db.patch(run.runId, { claimedAt: 0, scheduledFor: 0 });
    });
    expect((await started(as)).cursors.stories).toEqual({ hasNextPage: false, newestAt: 1_794_779_564_000 });
  });
});
