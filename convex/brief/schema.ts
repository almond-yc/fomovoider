import { defineTable } from "convex/server";
import { v } from "convex/values";

// A source the run went without. Never a failure: the brief is built from
// whatever the other sources brought in.
export const vSkippedSource = v.object({ platform: v.string(), reason: v.string() });

export const vBriefRunStatus = v.union(
  v.literal("collecting"),
  v.literal("judging"),
  v.literal("done"),
  v.literal("failed"),
);

export const vVerdictMedia = v.object({
  attach: v.boolean(),
  keepIndices: v.array(v.number()),
  why: v.string(),
});

export const vVerdict = v.object({
  isSlop: v.boolean(),
  slopTags: v.array(v.string()),
  matchesPreferences: v.boolean(),
  include: v.boolean(),
  priority: v.number(),
  reason: v.string(),
  media: vVerdictMedia,
});

export const briefTables = {
  // One per user and local date (YYYY-MM-DD in the user's time zone). Times
  // are epoch ms. since..cutoff is the createdAt window the run selected from;
  // the next run starts at this cutoff. pending counts posts still being judged.
  brief_runs: defineTable({
    userId: v.id("users"),
    date: v.string(),
    timeZone: v.string(),
    status: vBriefRunStatus,
    workflowId: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    since: v.optional(v.number()),
    cutoff: v.optional(v.number()),
    pending: v.number(),
    counts: v.object({
      selected: v.number(),
      kept: v.number(),
      filtered: v.number(),
      failed: v.number(),
    }),
    skipped: v.array(vSkippedSource),
    error: v.optional(v.string()),
  }).index("by_userId_and_date", ["userId", "date"]),

  // The agent's judgment of one post, saved once per post so a rerun only
  // judges new posts. Deleted with the post (lib/posts.ts).
  brief_verdicts: defineTable({
    userId: v.id("users"),
    postId: v.id("posts"),
    briefRunId: v.id("brief_runs"),
    ...vVerdict.fields,
    model: v.string(),
    judgedAt: v.number(),
  })
    .index("by_postId", ["postId"])
    .index("by_briefRunId", ["briefRunId"]),

  // A post in a day's brief. rank 0 comes first (priority, then recency).
  // mediaIndices are the indices into post.media the agent kept; empty when
  // attachMedia is false. Deleted with the post.
  brief_items: defineTable({
    briefRunId: v.id("brief_runs"),
    userId: v.id("users"),
    date: v.string(),
    postId: v.id("posts"),
    rank: v.number(),
    priority: v.number(),
    reason: v.string(),
    attachMedia: v.boolean(),
    mediaIndices: v.array(v.number()),
  })
    .index("by_briefRunId_and_rank", ["briefRunId", "rank"])
    .index("by_postId", ["postId"]),
};
