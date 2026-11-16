/// <reference types="vite/client" />
import workflowTest from "@convex-dev/workflow/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import crons from "./crons";
import schema from "./schema";
import { RETENTION_DAYS } from "./retention";
import { isDispatchTime, localTime } from "./brief/time";
import { MAX_POSTS_PER_BRIEF } from "./brief/workflow";

const modules = import.meta.glob("./**/*.ts");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// 6:30 in Los Angeles (PST, UTC-8).
const LA_DISPATCH = Date.parse("2026-11-16T14:30:00Z");

function setup() {
  const t = convexTest(schema, modules);
  workflowTest.register(t, "workflow");
  workpoolTest.register(t, "briefJudgePool");
  return t;
}
type T = ReturnType<typeof setup>;

beforeEach(() => {
  // Faked timers also keep the workflow and pool from running in the
  // background; these tests drive each step directly.
  vi.useFakeTimers();
  vi.setSystemTime(LA_DISPATCH);
});
afterEach(() => {
  vi.useRealTimers();
});

async function addUser(t: T, fields: Partial<Doc<"users">> = {}) {
  return await t.run((ctx) => ctx.db.insert("users", { onboardedAt: 1, slopDescription: "Crypto and hustle", ...fields }));
}

const runs = (t: T) => t.run((ctx) => ctx.db.query("brief_runs").collect());

async function addPost(t: T, userId: Id<"users">, n: number, fields: Partial<Doc<"posts">> = {}) {
  const createdAt = fields.createdAt ?? Date.now() - n * 60_000;
  return await t.run((ctx) =>
    ctx.db.insert("posts", {
      userId,
      id: `x:${n}`,
      platform: "x",
      author: { id: "x:a", platform: "x", handle: "ada", displayName: "Ada" },
      createdAt,
      text: `post ${n}`,
      media: [],
      permalink: `https://x.com/ada/status/${n}`,
      fetchedAt: createdAt,
      updatedAt: createdAt,
      ...fields,
    }),
  );
}

async function addRun(t: T, userId: Id<"users">, date = localTime(Date.now(), "America/Los_Angeles").date) {
  return await t.run((ctx) =>
    ctx.db.insert("brief_runs", {
      userId,
      date,
      timeZone: "America/Los_Angeles",
      status: "collecting",
      startedAt: Date.now(),
      pending: 0,
      counts: { selected: 0, kept: 0, filtered: 0, failed: 0 },
      skipped: [],
    }),
  );
}

const verdict = (over: Partial<Doc<"brief_verdicts">> = {}) => ({
  isSlop: false,
  slopTags: [],
  matchesPreferences: true,
  include: true,
  priority: 0.5,
  reason: "Real update",
  media: { attach: false, keepIndices: [], why: "" },
  ...over,
});

describe("dispatch time", () => {
  const zones = ["America/Los_Angeles", "America/New_York", "Europe/Athens", "Asia/Tokyo", "Asia/Kolkata", "Asia/Kathmandu"];

  test("lands on exactly one hourly :30 UTC tick per local day, at 6:30 to 7:29 local", () => {
    for (const zone of zones) {
      // Includes the 2026-11-01 US fall-back and a normal day after it.
      for (const day of ["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-16"]) {
        const ticks = Array.from({ length: 48 }, (_, h) => Date.parse(`${day}T00:30:00Z`) - DAY / 2 + h * HOUR);
        const hits = ticks.filter((at) => isDispatchTime(at, zone) && localTime(at, zone).date === day);
        expect(hits, `${zone} ${day}`).toHaveLength(1);
        const { minutes } = localTime(hits[0], zone);
        expect(minutes).toBeGreaterThanOrEqual(6 * 60 + 30);
        expect(minutes).toBeLessThan(7 * 60 + 30);
      }
    }
  });

  test("is registered in the shared cron registry, hourly at :30", () => {
    const job = (crons as unknown as { crons: Record<string, { name: string; schedule: unknown }> }).crons["brief:dispatch"];
    expect(job).toMatchObject({ name: "brief/crons:dispatch", schedule: { type: "hourly", minuteUTC: 30 } });
  });
});

describe("brief.crons.dispatch", () => {
  test("starts a run only for onboarded users whose local time is 6:30, defaulting to Los Angeles", async () => {
    const t = setup();
    const la = await addUser(t, { timeZone: "America/Los_Angeles" });
    const unset = await addUser(t);
    const invalid = await addUser(t, { timeZone: "Mars/Olympus" });
    await addUser(t, { timeZone: "Asia/Tokyo" });
    await addUser(t, { timeZone: "America/Los_Angeles", onboardedAt: undefined });

    expect(await t.mutation(internal.brief.crons.dispatch, {})).toBe(3);
    const started = await runs(t);
    expect(started.map((r) => r.userId).sort()).toEqual([la, unset, invalid].sort());
    expect(started.every((r) => r.date === "2026-11-16" && r.workflowId !== undefined)).toBe(true);

    // Tokyo's 6:30 is 21:30 UTC.
    vi.setSystemTime(Date.parse("2026-11-16T21:30:00Z"));
    expect(await t.mutation(internal.brief.crons.dispatch, {})).toBe(1);
    expect((await runs(t)).find((r) => r.timeZone === "Asia/Tokyo")?.date).toBe("2026-11-17");
  });

  test("runs at most once per user per local date", async () => {
    const t = setup();
    const userId = await addUser(t);
    expect(await t.mutation(internal.brief.crons.dispatch, {})).toBe(1);
    expect(await t.mutation(internal.brief.crons.dispatch, {})).toBe(0);
    expect(await t.mutation(internal.brief.crons.startNow, { userId })).toBeNull();
    expect(await runs(t)).toHaveLength(1);
    vi.setSystemTime(LA_DISPATCH + DAY);
    expect(await t.mutation(internal.brief.crons.dispatch, {})).toBe(1);
    expect((await runs(t)).map((r) => r.date).sort()).toEqual(["2026-11-16", "2026-11-17"]);
  });
});

describe("brief.workflow.sources", () => {
  test("skips missing, paused and offline sources instead of failing", async () => {
    const t = setup();
    const userId = await addUser(t);
    const runId = await addRun(t, userId);
    expect(await t.query(internal.brief.workflow.sources, { runId })).toMatchObject({
      instagram: false,
      skipped: [
        { platform: "x", reason: "not connected" },
        { platform: "instagram", reason: "not connected" },
      ],
    });
    const accountId = await t.run((ctx) =>
      ctx.db.insert("connectedAccounts", {
        userId,
        platform: "instagram",
        session: { platform: "instagram", kind: "device", deviceId: "d" },
        status: "active",
      }),
    );
    const deviceId = await t.run((ctx) =>
      ctx.db.insert("instagram_devices", {
        userId,
        name: "iPhone",
        accountId,
        timezone: "America/Los_Angeles",
        scheduleEnabled: true,
        lastSeenAt: Date.now() - HOUR,
      }),
    );
    expect((await t.query(internal.brief.workflow.sources, { runId })).skipped).toContainEqual({
      platform: "instagram",
      reason: "device offline",
    });
    await t.run((ctx) => ctx.db.patch(deviceId, { lastSeenAt: Date.now(), pausedUntil: Date.now() + HOUR }));
    expect((await t.query(internal.brief.workflow.sources, { runId })).skipped).toContainEqual({
      platform: "instagram",
      reason: "device paused",
    });
    await t.run((ctx) => ctx.db.patch(deviceId, { pausedUntil: undefined }));
    expect(await t.query(internal.brief.workflow.sources, { runId })).toMatchObject({ instagram: true });
  });
});

describe("brief.workflow.xSyncFailure", () => {
  test("reports an X sync that recorded an error or never finished during the run", async () => {
    const t = setup();
    const userId = await addUser(t);
    const runId = await addRun(t, userId);
    const accountId = await t.run((ctx) =>
      ctx.db.insert("connectedAccounts", {
        userId,
        platform: "x",
        session: { platform: "x", kind: "oauth", accessToken: "t" },
        status: "error",
        lastError: { kind: "network" },
        lastSyncedAt: Date.now() - DAY,
      }),
    );
    const failure = () => t.query(internal.brief.workflow.xSyncFailure, { runId, accountId });
    expect(await failure()).toBe("sync failed: network");
    await t.run((ctx) => ctx.db.patch(accountId, { status: "active", lastError: undefined }));
    expect(await failure()).toBe("sync didn't complete");
    await t.run((ctx) => ctx.db.patch(accountId, { lastSyncedAt: Date.now() + 1000 }));
    expect(await failure()).toBeNull();
  });
});

describe("brief.workflow.select", () => {
  test("takes unjudged, unexpired, unhidden posts from the last 24 h, newest first, and drops sponsored ones without the model", async () => {
    const t = setup();
    const userId = await addUser(t);
    const other = await addUser(t);
    const fresh = await addPost(t, userId, 1);
    const older = await addPost(t, userId, 2, { createdAt: Date.now() - 23 * HOUR });
    await addPost(t, userId, 3, { createdAt: Date.now() - 25 * HOUR });
    await addPost(t, userId, 4, { format: "story", expiresAt: Date.now() - 1 });
    const hidden = await addPost(t, userId, 5);
    await t.run((ctx) => ctx.db.insert("postStates", { userId, postId: hidden, hiddenAt: 1 }));
    const judged = await addPost(t, userId, 6);
    const ad = await addPost(t, userId, 7, { platform: "instagram", id: "instagram:7" });
    await addPost(t, other, 8);

    const previousRun = await addRun(t, userId, "2026-11-10");
    await t.run(async (ctx) => {
      await ctx.db.insert("brief_verdicts", {
        userId,
        postId: judged,
        briefRunId: previousRun,
        ...verdict(),
        model: "test",
        judgedAt: 1,
      });
      await ctx.db.insert("instagram_postFacts", {
        userId,
        postId: "instagram:7",
        runId: await ctx.db.insert("instagram_runs", {
          deviceId: await ctx.db.insert("instagram_devices", {
            userId,
            name: "iPhone",
            timezone: "UTC",
            scheduleEnabled: true,
          }),
          trigger: "manual",
          scheduledFor: 0,
          state: "done",
          budget: { maxMs: 1, maxPosts: 1, maxStoryFrames: 1 },
        }),
        sponsored: true,
        suggested: false,
        isReel: false,
      });
    });

    const runId = await addRun(t, userId);
    expect(await t.mutation(internal.brief.workflow.select, { runId, skipped: [] })).toBe(2);
    const run = (await t.run((ctx) => ctx.db.get(runId)))!;
    expect(run).toMatchObject({ status: "judging", pending: 2 });
    expect(run.since).toBe(run.cutoff! - DAY);
    expect(run.counts.selected).toBe(3);
    const verdicts = await t.run((ctx) =>
      ctx.db.query("brief_verdicts").withIndex("by_briefRunId", (q) => q.eq("briefRunId", runId)).collect(),
    );
    expect(verdicts).toMatchObject([{ postId: ad, slopTags: ["ad"], include: false, model: "rule:sponsored" }]);
    // The two judged are fresh and older: every other post is out of the window, expired, hidden, judged, sponsored or someone else's.
    expect(await t.query(internal.brief.workflow.judgeInput, { postId: fresh })).not.toBeNull();
    expect(await t.query(internal.brief.workflow.judgeInput, { postId: older })).not.toBeNull();
    expect(await t.query(internal.brief.workflow.judgeInput, { postId: ad })).toBeNull();
  });

  test("starts at the previous brief's cutoff and caps at 200 posts", async () => {
    const t = setup();
    const userId = await addUser(t);
    const prev = await addRun(t, userId, "2026-11-15");
    const cutoff = Date.now() - 2 * HOUR;
    await t.run((ctx) => ctx.db.patch(prev, { cutoff, status: "done" }));
    await addPost(t, userId, 999, { createdAt: cutoff - 1 });
    for (let n = 0; n < MAX_POSTS_PER_BRIEF + 5; n++) await addPost(t, userId, n, { createdAt: Date.now() - n * 1000 });
    const runId = await addRun(t, userId);
    expect(await t.mutation(internal.brief.workflow.select, { runId, skipped: [{ platform: "x", reason: "not connected" }] })).toBe(
      MAX_POSTS_PER_BRIEF,
    );
    expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({
      since: cutoff,
      skipped: [{ platform: "x", reason: "not connected" }],
      counts: { selected: MAX_POSTS_PER_BRIEF },
    });
  });
});

describe("saving the brief", () => {
  async function judgedRun(t: T) {
    const userId = await addUser(t);
    const media = [
      { kind: "image" as const, url: "https://img/0.jpg" },
      { kind: "image" as const, url: "https://img/1.jpg" },
      { kind: "video" as const, url: "https://img/2.mp4" },
    ];
    const low = await addPost(t, userId, 1, { media });
    const highOld = await addPost(t, userId, 2, { createdAt: Date.now() - 3 * HOUR });
    const highNew = await addPost(t, userId, 3, { createdAt: Date.now() - HOUR });
    const slop = await addPost(t, userId, 4);
    const runId = await addRun(t, userId);
    await t.mutation(internal.brief.workflow.select, { runId, skipped: [] });
    const save = (postId: Id<"posts">, v: ReturnType<typeof verdict>) =>
      t.mutation(internal.brief.workflow.saveVerdict, { runId, postId, verdict: v, model: "fake" });
    await save(low, verdict({ priority: 0.2, media: { attach: true, keepIndices: [2, 0], why: "photos" } }));
    await save(low, verdict({ priority: 0.9, include: false }));
    await save(highOld, verdict({ priority: 0.8 }));
    await save(highNew, verdict({ priority: 0.8 }));
    await save(slop, verdict({ isSlop: true, include: false, slopTags: ["engagement_bait"] }));
    return { t, userId, runId, low, highOld, highNew, slop };
  }

  test("saves each verdict once and wakes the workflow after the last post", async () => {
    const t = setup();
    const { runId } = await judgedRun(t);
    expect(await t.run((ctx) => ctx.db.query("brief_verdicts").collect())).toHaveLength(4);
    const finish = (kind: "success" | "failed") =>
      t.mutation(internal.brief.workflow.onJudged, {
        workId: "w",
        context: { runId },
        result: kind === "success" ? { kind, returnValue: null } : { kind, error: "429" },
      } as never);
    await finish("success");
    await finish("success");
    await finish("failed");
    expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({ pending: 1, counts: { failed: 1 } });
    await finish("success");
    expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({ pending: 0 });
  });

  test("ranks kept posts by priority then recency, with only the media the agent kept, scoped to the user", async () => {
    const t = setup();
    const { userId, runId, low, highOld, highNew } = await judgedRun(t);
    await t.mutation(internal.brief.workflow.finalize, { runId });
    expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({
      status: "done",
      counts: { selected: 4, kept: 3, filtered: 1 },
    });

    const as = t.withIdentity({ subject: `${userId}|session` });
    const today = await as.query(api.brief.today, {});
    expect(today.date).toBe("2026-11-16");
    expect(today.brief?.items.map((i) => i.post._id)).toEqual([highNew, highOld, low]);
    expect(today.brief?.items[2].post.media.map((m) => m.url)).toEqual(["https://img/2.mp4", "https://img/0.jpg"]);
    expect(today.brief?.items[0].post.media).toEqual([]);
    expect(await as.query(api.brief.byDate, { date: "2026-11-16" })).toEqual(today.brief);
    await t.run((ctx) => ctx.db.patch(highNew, { format: "story", expiresAt: Date.now() + 1000 }));
    vi.setSystemTime(Date.now() + 2000);
    expect((await as.query(api.brief.byDate, { date: "2026-11-16" }))?.items.map((i) => i.post._id)).toEqual([highOld, low]);
    vi.setSystemTime(LA_DISPATCH);
    expect(await as.query(api.brief.byDate, { date: "2026-11-15" })).toBeNull();
    expect(await as.query(api.brief.dates, {})).toEqual({
      today: "2026-11-16",
      days: [{ date: "2026-11-16", status: "done", kept: 3 }],
    });

    const stranger = t.withIdentity({ subject: `${await addUser(t)}|session` });
    expect((await stranger.query(api.brief.today, {})).brief).toBeNull();
    expect(await stranger.query(api.brief.dates, {})).toMatchObject({ days: [] });
    await expect(t.query(api.brief.today, {})).rejects.toThrow("Not signed in");
  });

  test("marks the run failed when every model call failed", async () => {
    const t = setup();
    const userId = await addUser(t);
    await addPost(t, userId, 1);
    const runId = await addRun(t, userId);
    await t.mutation(internal.brief.workflow.select, { runId, skipped: [] });
    await t.mutation(internal.brief.workflow.onJudged, {
      workId: "w",
      context: { runId },
      result: { kind: "failed", error: "OPENAI_API_KEY is not set on this deployment" },
    } as never);
    await t.mutation(internal.brief.workflow.finalize, { runId });
    expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({ status: "failed", counts: { failed: 1, kept: 0 } });
  });

  test("retention deletes a post's verdict and brief item with the post", async () => {
    const t = setup();
    const { runId, low } = await judgedRun(t);
    await t.mutation(internal.brief.workflow.finalize, { runId });
    vi.setSystemTime(Date.now() + (RETENTION_DAYS + 1) * DAY);
    await t.mutation(internal.retention.run, { phase: "old" });
    expect(await t.run((ctx) => ctx.db.get(low))).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("brief_verdicts").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("brief_items").collect())).toEqual([]);
  });
});

describe("brief.setTimeZone", () => {
  test("stores a valid IANA zone and rejects others", async () => {
    const t = setup();
    const userId = await addUser(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.brief.setTimeZone, { timeZone: "Europe/Athens" });
    expect((await t.run((ctx) => ctx.db.get(userId)))?.timeZone).toBe("Europe/Athens");
    await expect(as.mutation(api.brief.setTimeZone, { timeZone: "Nowhere/Else" })).rejects.toThrow("Unknown time zone");
  });
});

describe("brief.rerunToday", () => {
  test("clears today's run, its items and verdicts, starts a new one, and refuses while one is running", async () => {
    const t = setup();
    const userId = await addUser(t);
    const postId = await addPost(t, userId, 1);
    const oldRun = await addRun(t, userId);
    const yesterday = await addRun(t, userId, "2026-11-15");
    await t.run(async (ctx) => {
      await ctx.db.insert("brief_verdicts", { userId, postId, briefRunId: oldRun, ...verdict(), model: "m", judgedAt: 1 });
      await ctx.db.insert("brief_items", {
        briefRunId: oldRun,
        userId,
        date: "2026-11-16",
        postId,
        rank: 0,
        priority: 0.5,
        reason: "Real update",
        attachMedia: false,
        mediaIndices: [],
      });
    });
    const as = t.withIdentity({ subject: `${userId}|session` });

    await expect(as.mutation(api.brief.rerunToday, {})).rejects.toThrow("still running");
    await t.run((ctx) => ctx.db.patch(oldRun, { status: "done" }));
    const newRun = await as.mutation(api.brief.rerunToday, {});

    expect(await t.run((ctx) => ctx.db.get(oldRun))).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("brief_verdicts").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("brief_items").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.get(yesterday))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(newRun))).toMatchObject({ date: "2026-11-16", status: "collecting" });
    expect((await t.run((ctx) => ctx.db.get(newRun)))?.workflowId).toBeDefined();
    await expect(as.mutation(api.brief.rerunToday, {})).rejects.toThrow("still running");
    await expect(t.mutation(api.brief.rerunToday, {})).rejects.toThrow("Not signed in");
  });
});
