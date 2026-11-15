/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { sha256Hex } from "./common";
import { slotsForNextDay } from "./schedule";

const modules = import.meta.glob("/convex/**/*.ts");
const TOKEN = "device-token";
const me = { id: "instagram:nico", platform: "instagram", handle: "nico", displayName: "Nico" };

async function paired() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const { code } = await t.mutation(internal.instagram.devices.pairForUser, { userId });
  const { deviceId } = await t.mutation(api.instagram.agent.redeemPairing, {
    code,
    tokenHash: await sha256Hex(TOKEN),
  });
  return { t, userId, deviceId };
}

async function claim(t: Awaited<ReturnType<typeof paired>>["t"], userId: any) {
  await t.mutation(internal.instagram.devices.runNowForUser, { userId });
  const claimed = await t.mutation(api.instagram.agent.claimRun, { token: TOKEN });
  if (claimed.kind !== "run") throw new Error(`expected a run, got ${claimed.kind}`);
  return claimed;
}

function item(id: string, storageId: any, extra = {}) {
  return {
    id,
    author: { id: "instagram:alice", platform: "instagram", handle: "alice", displayName: "alice" },
    createdAt: "2026-11-15T10:00:00.000Z",
    text: "hello",
    permalink: "https://www.instagram.com/alice/",
    format: "post" as const,
    media: [{ storageId, kind: "image" as const, width: 390, height: 500 }],
    facts: { sponsored: false, suggested: false, isReel: false, followsAuthor: true },
    ...extra,
  };
}

describe("instagram device runs", () => {
  test("pairing connects a pending device account", async () => {
    const { t, userId } = await paired();
    const account = await t.run((ctx) =>
      ctx.db
        .query("connectedAccounts")
        .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId).eq("platform", "instagram"))
        .unique(),
    );
    expect(account?.status).toBe("pending");
    expect(account?.session.kind).toBe("device");
  });

  test("a pairing code works once", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const { code } = await t.mutation(internal.instagram.devices.pairForUser, { userId });
    await t.mutation(api.instagram.agent.redeemPairing, { code, tokenHash: "a" });
    await expect(t.mutation(api.instagram.agent.redeemPairing, { code, tokenHash: "b" })).rejects.toThrow(
      "Invalid or expired pairing code",
    );
  });

  test("a device never writes to an account that is not its owner's device session", async () => {
    const { t, userId } = await paired();
    await t.mutation(internal.instagram.devices.runNowForUser, { userId });
    await t.run(async (ctx) => {
      const account = await ctx.db.query("connectedAccounts").unique();
      await ctx.db.patch(account!._id, { session: { platform: "instagram", kind: "device", deviceId: "other" } });
    });
    await expect(t.mutation(api.instagram.agent.claimRun, { token: TOKEN })).rejects.toThrow(
      "not connected to its owner's Instagram account",
    );
  });

  test("unknown tokens are rejected", async () => {
    const { t } = await paired();
    await expect(t.mutation(api.instagram.agent.claimRun, { token: "nope" })).rejects.toThrow("Unknown device token");
  });

  test("ingest needs the identity first, then stores posts and facts", async () => {
    const { t, userId } = await paired();
    const run = await claim(t, userId);
    expect(run.budget).toEqual({ maxMs: 480_000, maxPosts: 60, maxStoryFrames: 40 });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["jpeg"])));
    await expect(
      t.mutation(api.instagram.agent.submitItems, { token: TOKEN, runId: run.runId, items: [item("instagram:a", storageId)] }),
    ).rejects.toThrow("verifyIdentity");

    expect(await t.mutation(api.instagram.agent.reportIdentity, { token: TOKEN, runId: run.runId, me })).toBe("active");
    await t.mutation(api.instagram.agent.submitItems, {
      token: TOKEN,
      runId: run.runId,
      items: [
        item("instagram:a", storageId, { extracted: { place: { name: "Berkeley" } } }),
        item("instagram:b", storageId, {
          format: "story",
          expiresAt: "2026-11-16T10:00:00.000Z",
          facts: { sponsored: true, suggested: false, isReel: false, storyTrayPosition: 3 },
        }),
      ],
    });
    await t.mutation(api.instagram.agent.finishRun, {
      token: TOKEN,
      runId: run.runId,
      stats: { posts: 1, storyFrames: 1, durationMs: 1000 },
    });

    const posts = await t.run((ctx) => ctx.db.query("posts").collect());
    expect(posts.map((p) => [p.id, p.format, p.extracted?.place?.name])).toEqual([
      ["instagram:a", "post", "Berkeley"],
      ["instagram:b", "story", undefined],
    ]);
    expect(posts[0].media[0].url).toMatch(/^https?:/);
    const facts = await t.run((ctx) => ctx.db.query("instagram_postFacts").collect());
    expect(facts.find((f) => f.postId === "instagram:b")).toMatchObject({ sponsored: true, storyTrayPosition: 3 });
    const runDoc = await t.run((ctx) => ctx.db.get(run.runId));
    expect(runDoc?.state).toBe("done");
    const cursor = await t.run((ctx) => ctx.db.query("feedCursors").unique());
    expect(cursor?.caughtUp).toBe(true);

    const next = await claim(t, userId);
    expect(next.knownIds.sort()).toEqual(["instagram:a", "instagram:b"]);
  });

  test("a tripwire aborts the run and pauses the device for 72 hours", async () => {
    const { t, userId, deviceId } = await paired();
    const run = await claim(t, userId);
    await t.mutation(api.instagram.agent.reportIdentity, { token: TOKEN, runId: run.runId, me });
    await t.mutation(api.instagram.agent.finishRun, {
      token: TOKEN,
      runId: run.runId,
      stats: { posts: 0, storyFrames: 0, durationMs: 10 },
      tripwire: { kind: "challenge", screenText: "Help us confirm it's you" },
    });
    const device = await t.run((ctx) => ctx.db.get(deviceId));
    expect(device!.pausedUntil! - Date.now()).toBeGreaterThan(71 * 3_600_000);
    const account = await t.run((ctx) => ctx.db.query("connectedAccounts").unique());
    expect(account?.status).toBe("expired");
    await expect(t.mutation(internal.instagram.devices.runNowForUser, { userId })).rejects.toThrow("paused");
    expect((await t.mutation(api.instagram.agent.claimRun, { token: TOKEN })).kind).toBe("paused");
    expect(await t.mutation(internal.instagram.schedule.planDay, {})).toBe(0);
  });

  test("disconnect revokes the token, cancels runs and removes the account", async () => {
    const { t, userId, deviceId } = await paired();
    await t.mutation(internal.instagram.devices.runNowForUser, { userId });
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.instagram.devices.disconnect, {});
    await expect(t.mutation(api.instagram.agent.claimRun, { token: TOKEN })).rejects.toThrow("Unknown device token");
    const runs = await t.run((ctx) => ctx.db.query("instagram_runs").collect());
    expect(runs.map((r) => r.state)).toEqual(["skipped"]);
    expect(await t.run((ctx) => ctx.db.query("connectedAccounts").collect())).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(deviceId)))?.accountId).toBeUndefined();
    expect(await as.query(api.instagram.devices.status, {})).toMatchObject({ paired: false });
  });

  test("planDay schedules two jittered runs per device and no duplicates", async () => {
    const { t } = await paired();
    expect(await t.mutation(internal.instagram.schedule.planDay, {})).toBe(2);
    expect(await t.mutation(internal.instagram.schedule.planDay, {})).toBe(0);
    const runs = await t.run((ctx) => ctx.db.query("instagram_runs").collect());
    expect(runs.every((r) => r.trigger === "scheduled" && r.state === "pending")).toBe(true);
  });
});

test("slotsForNextDay lands on local 9:30 and 19:30", () => {
  const now = Date.UTC(2026, 10, 15, 20, 0);
  const [morning, evening] = slotsForNextDay("America/Los_Angeles", now);
  expect(new Date(morning).toISOString()).toBe("2026-11-16T17:30:00.000Z");
  expect(new Date(evening).toISOString()).toBe("2026-11-17T03:30:00.000Z");
});
