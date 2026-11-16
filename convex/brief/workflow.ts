import { vWorkflowId, WorkflowManager, type WorkflowId } from "@convex-dev/workflow";
import { vOnCompleteArgs, vResultValidator, Workpool } from "@convex-dev/workpool";
import { v } from "convex/values";
import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { resolvePost } from "../lib/media";
import { vSkippedSource, vVerdict } from "./schema";

// One durable workflow per user per local date:
// collect (X sync, Instagram run) -> select -> judge (pool) -> save.

export const workflow = new WorkflowManager(components.workflow);

// The model calls: about 5 at a time across every user, retried with
// exponential backoff and jitter, which is what absorbs 429s.
export const judgePool = new Workpool(components.briefJudgePool, {
  maxParallelism: 5,
  retryActionsByDefault: true,
  defaultRetryBehavior: { maxAttempts: 5, initialBackoffMs: 4000, base: 2 },
});

export const MAX_POSTS_PER_BRIEF = 200;
export const FIRST_BRIEF_WINDOW_MS = 24 * 60 * 60 * 1000;
export const INSTAGRAM_WAIT_MS = 20 * 60 * 1000;
export const INSTAGRAM_POLL_MS = 60 * 1000;
// The host agent polls about once a minute; a device quiet for longer than
// this is offline and isn't sent a run it would pick up hours later.
export const INSTAGRAM_OFFLINE_MS = 10 * 60 * 1000;
const JUDGED_EVENT = "judged";

type Skipped = { platform: string; reason: string };

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// Creates the day's run and starts its workflow, once per user and date.
// Returns null when that date already has a run.
export async function startBrief(
  ctx: MutationCtx,
  userId: Id<"users">,
  date: string,
  timeZone: string,
): Promise<Id<"brief_runs"> | null> {
  const existing = await ctx.db
    .query("brief_runs")
    .withIndex("by_userId_and_date", (q) => q.eq("userId", userId).eq("date", date))
    .first();
  if (existing) return null;
  const runId = await ctx.db.insert("brief_runs", {
    userId,
    date,
    timeZone,
    status: "collecting",
    startedAt: Date.now(),
    pending: 0,
    counts: { selected: 0, kept: 0, filtered: 0, failed: 0 },
    skipped: [],
  });
  const workflowId: WorkflowId = await workflow.start(
    ctx,
    internal.brief.workflow.briefWorkflow,
    { runId },
    { onComplete: internal.brief.workflow.onWorkflowComplete, context: { runId } },
  );
  await ctx.db.patch(runId, { workflowId });
  return runId;
}

export const briefWorkflow = workflow
  .define({ args: { runId: v.id("brief_runs") }, returns: v.null() })
  .handler(async (step, { runId }): Promise<null> => {
    const sources = await step.runQuery(internal.brief.workflow.sources, { runId });
    const skipped: Skipped[] = [...sources.skipped];

    let instagramRunId: Id<"instagram_runs"> | null = null;
    if (sources.instagram) {
      try {
        instagramRunId = await step.runMutation(internal.instagram.devices.runNowForUser, {
          userId: sources.userId,
        });
      } catch (error) {
        skipped.push({ platform: "instagram", reason: message(error) });
      }
    }

    if (sources.xAccountId) {
      try {
        await step.runAction(internal.x.sync.syncAccount, { accountId: sources.xAccountId }, { retry: true });
      } catch (error) {
        skipped.push({ platform: "x", reason: message(error) });
      }
    }

    if (instagramRunId) {
      let state = await step.runQuery(internal.brief.workflow.instagramRunState, { runId: instagramRunId });
      for (let waited = 0; waited < INSTAGRAM_WAIT_MS && (state === "pending" || state === "claimed"); ) {
        await step.sleep(INSTAGRAM_POLL_MS, { name: "waitForInstagram" });
        waited += INSTAGRAM_POLL_MS;
        state = await step.runQuery(internal.brief.workflow.instagramRunState, { runId: instagramRunId });
      }
      if (state === "pending" || state === "claimed") {
        skipped.push({ platform: "instagram", reason: "run didn't finish within 20 minutes" });
      } else if (state !== "done") {
        skipped.push({ platform: "instagram", reason: `run ${state ?? "missing"}` });
      }
    }

    const pending = await step.runMutation(internal.brief.workflow.select, { runId, skipped });
    if (pending > 0) await step.awaitEvent({ name: JUDGED_EVENT });
    await step.runMutation(internal.brief.workflow.finalize, { runId });
    return null;
  });

// Which sources the run collects from, and the ones it goes without.
export const sources = internalQuery({
  args: { runId: v.id("brief_runs") },
  returns: v.object({
    userId: v.id("users"),
    xAccountId: v.optional(v.id("connectedAccounts")),
    instagram: v.boolean(),
    skipped: v.array(vSkippedSource),
  }),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("Brief run not found");
    const skipped: Skipped[] = [];
    const x = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", run.userId).eq("platform", "x"))
      .unique();
    let xAccountId: Id<"connectedAccounts"> | undefined;
    if (!x) skipped.push({ platform: "x", reason: "not connected" });
    else if (x.status === "expired") skipped.push({ platform: "x", reason: "session expired" });
    else if (x.status === "resetting") skipped.push({ platform: "x", reason: "account is resetting" });
    else xAccountId = x._id;

    const device = await ctx.db
      .query("instagram_devices")
      .withIndex("by_userId", (q) => q.eq("userId", run.userId))
      .first();
    const now = Date.now();
    let instagram = false;
    if (!device?.accountId) skipped.push({ platform: "instagram", reason: "not connected" });
    else if (device.pausedUntil !== undefined && device.pausedUntil > now) {
      skipped.push({ platform: "instagram", reason: "device paused" });
    } else if (device.lastSeenAt === undefined || device.lastSeenAt < now - INSTAGRAM_OFFLINE_MS) {
      skipped.push({ platform: "instagram", reason: "device offline" });
    } else instagram = true;
    return { userId: run.userId, xAccountId, instagram, skipped };
  },
});

export const instagramRunState = internalQuery({
  args: { runId: v.id("instagram_runs") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { runId }) => (await ctx.db.get(runId))?.state ?? null,
});

function isSponsored(post: Doc<"posts">, facts: Doc<"instagram_postFacts"> | null) {
  return (post as { sponsored?: boolean }).sponsored === true || facts?.sponsored === true;
}

async function postFacts(ctx: MutationCtx | Parameters<typeof resolvePost>[0], post: Doc<"posts">) {
  if (post.platform !== "instagram") return null;
  return await ctx.db
    .query("instagram_postFacts")
    .withIndex("by_userId_and_postId", (q) => q.eq("userId", post.userId).eq("postId", post.id))
    .first();
}

// Picks the posts this brief judges: created since the previous brief's
// cutoff (the last 24 h for the first one), with no verdict yet, not expired
// and not hidden, newest first, at most MAX_POSTS_PER_BRIEF. Sponsored posts
// get an "ad" verdict here without a model call. The rest go to the judge
// pool; returns how many.
export const select = internalMutation({
  args: { runId: v.id("brief_runs"), skipped: v.array(vSkippedSource) },
  returns: v.number(),
  handler: async (ctx, { runId, skipped }) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("Brief run not found");
    const now = Date.now();
    const previous = await ctx.db
      .query("brief_runs")
      .withIndex("by_userId_and_date", (q) => q.eq("userId", run.userId).lt("date", run.date))
      .order("desc")
      .filter((q) => q.neq(q.field("cutoff"), undefined))
      .first();
    const since = previous?.cutoff ?? now - FIRST_BRIEF_WINDOW_MS;
    const toJudge: Id<"posts">[] = [];
    let selected = 0;
    const posts = ctx.db
      .query("posts")
      .withIndex("by_userId_and_createdAt", (q) =>
        q.eq("userId", run.userId).gt("createdAt", since).lte("createdAt", now),
      )
      .order("desc");
    for await (const post of posts) {
      if (selected >= MAX_POSTS_PER_BRIEF) break;
      if (post.expiresAt !== undefined && post.expiresAt <= now) continue;
      const verdict = await ctx.db
        .query("brief_verdicts")
        .withIndex("by_postId", (q) => q.eq("postId", post._id))
        .first();
      if (verdict) continue;
      const state = await ctx.db
        .query("postStates")
        .withIndex("by_userId_and_postId", (q) => q.eq("userId", run.userId).eq("postId", post._id))
        .unique();
      if (state?.hiddenAt !== undefined) continue;
      selected += 1;
      if (isSponsored(post, await postFacts(ctx, post))) {
        await ctx.db.insert("brief_verdicts", {
          userId: run.userId,
          postId: post._id,
          briefRunId: runId,
          isSlop: true,
          slopTags: ["ad"],
          matchesPreferences: false,
          include: false,
          priority: 0,
          reason: "Sponsored",
          media: { attach: false, keepIndices: [], why: "Sponsored post" },
          model: "rule:sponsored",
          judgedAt: now,
        });
      } else toJudge.push(post._id);
    }
    await ctx.db.patch(runId, {
      status: "judging",
      since,
      cutoff: now,
      pending: toJudge.length,
      skipped,
      counts: { ...run.counts, selected },
    });
    if (toJudge.length > 0) {
      await judgePool.enqueueActionBatch(
        ctx,
        internal.brief.judge.judgePost,
        toJudge.map((postId) => ({ runId, postId })),
        { onComplete: internal.brief.workflow.onJudged, context: { runId } },
      );
    }
    return toJudge.length;
  },
});

// What judgePost needs for one post; null once it has a verdict or is gone.
export const judgeInput = internalQuery({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const post = await ctx.db.get(postId);
    if (!post) return null;
    const verdict = await ctx.db
      .query("brief_verdicts")
      .withIndex("by_postId", (q) => q.eq("postId", postId))
      .first();
    if (verdict) return null;
    const user = await ctx.db.get(post.userId);
    const facts = await postFacts(ctx, post);
    const resolved = await resolvePost(ctx, post);
    const flags = post as { suggested?: boolean; sponsored?: boolean };
    return {
      post: {
        ...resolved,
        facts:
          facts || flags.suggested !== undefined
            ? {
                sponsored: facts?.sponsored ?? flags.sponsored ?? false,
                suggested: (facts?.suggested ?? false) || flags.suggested === true,
                isReel: facts?.isReel ?? false,
                followsAuthor: facts?.followsAuthor,
              }
            : undefined,
      },
      slopDescription: user?.slopDescription,
      // ALM-33 adds the "want to see more of" field; until then it's empty.
      wantToSee: undefined as string | undefined,
    };
  },
});

// Keeps the first verdict per post; a retried or duplicate job is a no-op.
export const saveVerdict = internalMutation({
  args: { runId: v.id("brief_runs"), postId: v.id("posts"), verdict: vVerdict, model: v.string() },
  returns: v.null(),
  handler: async (ctx, { runId, postId, verdict, model }) => {
    const post = await ctx.db.get(postId);
    if (!post) return null;
    const existing = await ctx.db
      .query("brief_verdicts")
      .withIndex("by_postId", (q) => q.eq("postId", postId))
      .first();
    if (existing) return null;
    await ctx.db.insert("brief_verdicts", {
      userId: post.userId,
      postId,
      briefRunId: runId,
      ...verdict,
      model,
      judgedAt: Date.now(),
    });
    return null;
  },
});

// Called by the pool once per post, after its last attempt. When the last
// post is done, wakes the workflow.
export const onJudged = internalMutation({
  args: vOnCompleteArgs(v.object({ runId: v.id("brief_runs") })),
  returns: v.null(),
  handler: async (ctx, { context: { runId }, result }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "judging") return null;
    const pending = Math.max(0, run.pending - 1);
    const failed = run.counts.failed + (result.kind === "success" ? 0 : 1);
    await ctx.db.patch(runId, { pending, counts: { ...run.counts, failed } });
    if (pending === 0 && run.workflowId) {
      await workflow.sendEvent(ctx, { workflowId: run.workflowId as WorkflowId, name: JUDGED_EVENT });
    }
    return null;
  },
});

// Saves the brief: items ranked by priority, then recency.
export const finalize = internalMutation({
  args: { runId: v.id("brief_runs") },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) return null;
    const verdicts = await ctx.db
      .query("brief_verdicts")
      .withIndex("by_briefRunId", (q) => q.eq("briefRunId", runId))
      .collect();
    const kept: { verdict: Doc<"brief_verdicts">; post: Doc<"posts"> }[] = [];
    for (const verdict of verdicts) {
      if (!verdict.include) continue;
      const post = await ctx.db.get(verdict.postId);
      if (post) kept.push({ verdict, post });
    }
    kept.sort((a, b) => b.verdict.priority - a.verdict.priority || b.post.createdAt - a.post.createdAt);
    for (const [rank, { verdict, post }] of kept.entries()) {
      await ctx.db.insert("brief_items", {
        briefRunId: runId,
        userId: run.userId,
        date: run.date,
        postId: post._id,
        rank,
        priority: verdict.priority,
        reason: verdict.reason,
        attachMedia: verdict.media.attach,
        mediaIndices: verdict.media.attach ? verdict.media.keepIndices : [],
      });
    }
    await ctx.db.patch(runId, {
      status: "done",
      finishedAt: Date.now(),
      pending: 0,
      counts: { ...run.counts, kept: kept.length, filtered: verdicts.length - kept.length },
    });
    return null;
  },
});

export const onWorkflowComplete = internalMutation({
  args: { workflowId: vWorkflowId, result: vResultValidator, context: v.object({ runId: v.id("brief_runs") }) },
  returns: v.null(),
  handler: async (ctx, { result, context: { runId } }) => {
    if (result.kind === "success") return null;
    const run = await ctx.db.get(runId);
    if (!run || run.status === "done") return null;
    await ctx.db.patch(runId, {
      status: "failed",
      finishedAt: Date.now(),
      error: result.kind === "failed" ? result.error : "canceled",
    });
    return null;
  },
});
