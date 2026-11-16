import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { requireUserId } from "./lib/auth";
import { resolvePost } from "./lib/media";
import { isValidTimeZone, localTime, resolveTimeZone } from "./brief/time";

// The Morning Brief as the app reads it. Every query is the signed-in user's.
// Dates are the user's local YYYY-MM-DD; times are epoch ms.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DATES = 60;

async function briefFor(ctx: QueryCtx, userId: Id<"users">, date: string) {
  const run = await ctx.db
    .query("brief_runs")
    .withIndex("by_userId_and_date", (q) => q.eq("userId", userId).eq("date", date))
    .first();
  if (!run) return null;
  const rows = await ctx.db
    .query("brief_items")
    .withIndex("by_briefRunId_and_rank", (q) => q.eq("briefRunId", run._id))
    .collect();
  const items = [];
  const now = Date.now();
  for (const item of rows) {
    const post = await ctx.db.get(item.postId);
    if (!post || (post.expiresAt !== undefined && post.expiresAt <= now)) continue;
    const state = await ctx.db
      .query("postStates")
      .withIndex("by_userId_and_postId", (q) => q.eq("userId", userId).eq("postId", post._id))
      .unique();
    if (state?.hiddenAt !== undefined) continue;
    const resolved = await resolvePost(ctx, post);
    items.push({
      _id: item._id,
      rank: item.rank,
      reason: item.reason,
      priority: item.priority,
      post: {
        ...resolved,
        media: item.attachMedia ? item.mediaIndices.flatMap((i) => resolved.media[i] ?? []) : [],
        savedAt: state?.savedAt,
      },
    });
  }
  return { run: runView(run), items };
}

function runView(run: Doc<"brief_runs">) {
  return {
    date: run.date,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    counts: run.counts,
    skipped: run.skipped,
  };
}

async function viewerTimeZone(ctx: QueryCtx, userId: Id<"users">) {
  return resolveTimeZone((await ctx.db.get(userId))?.timeZone);
}

// Today's date in the user's zone, with its brief (null before 6:30, when
// it hasn't started yet).
export const today = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const date = localTime(Date.now(), await viewerTimeZone(ctx, userId)).date;
    return { date, brief: await briefFor(ctx, userId, date) };
  },
});

export const byDate = query({
  args: { date: v.string() },
  handler: async (ctx, { date }) => {
    const userId = await requireUserId(ctx);
    if (!DATE.test(date)) throw new Error("date must be YYYY-MM-DD");
    return await briefFor(ctx, userId, date);
  },
});

// The days that have a brief, newest first, and today's date in the user's
// zone so the app's date strip agrees with the server.
export const dates = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const today = localTime(Date.now(), await viewerTimeZone(ctx, userId)).date;
    const runs = await ctx.db
      .query("brief_runs")
      .withIndex("by_userId_and_date", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MAX_DATES);
    return { today, days: runs.map((r) => ({ date: r.date, status: r.status, kept: r.counts.kept })) };
  },
});

// The app sends the device's IANA zone on launch. The brief runs at 6:30 there.
export const setTimeZone = mutation({
  args: { timeZone: v.string() },
  returns: v.null(),
  handler: async (ctx, { timeZone }) => {
    const userId = await requireUserId(ctx);
    if (!isValidTimeZone(timeZone)) throw new Error(`Unknown time zone: ${timeZone}`);
    const user = await ctx.db.get(userId);
    if (user && user.timeZone !== timeZone) await ctx.db.patch(userId, { timeZone });
    return null;
  },
});
