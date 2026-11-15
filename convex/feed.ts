import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUserId } from "./lib/auth";
import { isoDate } from "./lib/normalize";

// Posts a connector scored below this are left out of the feed. Posts with no
// relevance (the connector doesn't score) are always shown.
export const RELEVANCE_THRESHOLD = 0.5;

// The finite feed: posts from every platform, newest first, down to each
// platform's caught-up point. When isDone is true the app shows
// "You're all caught up".
export const page = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const userId = await requireUserId(ctx);
    const cursors = await ctx.db
      .query("feedCursors")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId))
      .collect();
    const seen = cursors.flatMap((c) =>
      c.seenUntil === undefined ? [] : [{ platform: c.platform, seenUntil: c.seenUntil }],
    );
    return await ctx.db
      .query("posts")
      .withIndex("by_userId_and_createdAt", (q) => q.eq("userId", userId))
      .order("desc")
      .filter((q) =>
        q.and(
          q.or(
            q.eq(q.field("relevance"), undefined),
            q.gte(q.field("relevance.score"), RELEVANCE_THRESHOLD),
          ),
          ...seen.map(({ platform, seenUntil }) =>
            q.or(q.neq(q.field("platform"), platform), q.gt(q.field("createdAt"), seenUntil)),
          ),
        ),
      )
      .paginate(paginationOpts);
  },
});

// Called when the user reaches the end of the feed. `until` is the createdAt
// of the newest post the app showed; every connected platform's feed now ends
// there, so the next session only shows what is newer.
export const markCaughtUp = mutation({
  args: { until: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const until = isoDate(args.until);
    const accounts = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId))
      .collect();
    for (const { platform } of accounts) {
      const cursor = await ctx.db
        .query("feedCursors")
        .withIndex("by_userId_and_platform", (q) =>
          q.eq("userId", userId).eq("platform", platform),
        )
        .unique();
      if (!cursor) {
        await ctx.db.insert("feedCursors", { userId, platform, caughtUp: false, seenUntil: until });
      } else if (cursor.seenUntil === undefined || cursor.seenUntil < until) {
        await ctx.db.patch(cursor._id, { seenUntil: until });
      }
    }
    return null;
  },
});
