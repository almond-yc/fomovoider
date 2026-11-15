import type { Crons } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { deletePost } from "./lib/posts";

export const RETENTION_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const BATCH = 100;

export function registerAppCrons(crons: Crons) {
  crons.daily("app:retention", { hourUTC: 11, minuteUTC: 0 }, internal.retention.run, {});
}

// Daily cleanup, in batches that reschedule themselves. First every post whose
// expiresAt has passed (stories), then every post older than RETENTION_DAYS
// that its user hasn't saved. Each goes with its stored media and states.
export const run = internalMutation({
  args: {
    phase: v.optional(v.union(v.literal("expired"), v.literal("old"))),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, { phase = "expired", cursor = null }) => {
    const now = Date.now();
    if (phase === "expired") {
      const expired = await ctx.db
        .query("posts")
        .withIndex("by_expiresAt", (q) => q.gte("expiresAt", 0).lte("expiresAt", now))
        .take(BATCH);
      for (const post of expired) await deletePost(ctx, post);
      await ctx.scheduler.runAfter(0, internal.retention.run, {
        phase: expired.length === BATCH ? "expired" : "old",
      });
      return null;
    }
    const result = await ctx.db
      .query("posts")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", now - RETENTION_DAYS * DAY))
      .paginate({ numItems: BATCH, cursor });
    for (const post of result.page) {
      const states = await ctx.db
        .query("postStates")
        .withIndex("by_postId", (q) => q.eq("postId", post._id))
        .collect();
      if (!states.some((s) => s.savedAt !== undefined)) await deletePost(ctx, post);
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, internal.retention.run, {
        phase: "old",
        cursor: result.continueCursor,
      });
    }
    return null;
  },
});
