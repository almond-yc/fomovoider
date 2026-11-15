import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUserId } from "./lib/auth";
import { resolvePost } from "./lib/media";

// Posts a connector scored below this are left out of the feed. Posts with no
// relevance (the connector doesn't score) are always shown.
export const RELEVANCE_THRESHOLD = 0.5;

// The finite feed: posts from every platform, newest first, down to each
// platform's caught-up point. Items whose expiresAt has passed (stories) are
// left out, and so are posts the user hid (postStates). Media and avatar
// URLs point at the stored copy when one exists, else at the platform.
// Dates are epoch ms. `caughtUp` is true only when this is the last
// page and every connected platform's connector reported it has nothing older
// left; that is when the app shows "You're all caught up". A last page with
// `caughtUp: false` means a connector is still paging in older posts.
export const page = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const userId = await requireUserId(ctx);
    const cursors = await ctx.db
      .query("feedCursors")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId))
      .collect();
    const accounts = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId))
      .collect();
    const seen = cursors.flatMap((c) =>
      c.seenUntil === undefined ? [] : [{ platform: c.platform, seenUntil: c.seenUntil }],
    );
    const hidden = await ctx.db
      .query("postStates")
      .withIndex("by_userId_and_hiddenAt", (q) => q.eq("userId", userId).gte("hiddenAt", 0))
      .collect();
    const now = Date.now();
    const result = await ctx.db
      .query("posts")
      .withIndex("by_userId_and_createdAt", (q) => q.eq("userId", userId))
      .order("desc")
      .filter((q) =>
        q.and(
          q.or(q.eq(q.field("expiresAt"), undefined), q.gt(q.field("expiresAt"), now)),
          q.or(
            q.eq(q.field("relevance"), undefined),
            q.gte(q.field("relevance.score"), RELEVANCE_THRESHOLD),
          ),
          ...seen.map(({ platform, seenUntil }) =>
            q.or(q.neq(q.field("platform"), platform), q.gt(q.field("createdAt"), seenUntil)),
          ),
          ...hidden.map(({ postId }) => q.neq(q.field("_id"), postId)),
        ),
      )
      .paginate(paginationOpts);
    const connectorsCaughtUp = accounts.every(
      ({ platform }) => cursors.find((c) => c.platform === platform)?.caughtUp === true,
    );
    return {
      ...result,
      page: await Promise.all(result.page.map((post) => resolvePost(ctx, post))),
      caughtUp: result.isDone && connectorsCaughtUp,
    };
  },
});

// Called when the app showed "You're all caught up". `until` is the createdAt
// (epoch ms, as feed.page returned it) of the newest post the app showed. Each platform whose connector has caught
// up now ends there, so the next session only shows what is newer. A platform
// still paging is left alone, so its older posts are not skipped.
export const markCaughtUp = mutation({
  args: { until: v.number() },
  returns: v.null(),
  handler: async (ctx, { until }) => {
    const userId = await requireUserId(ctx);
    const cursors = await ctx.db
      .query("feedCursors")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId))
      .collect();
    for (const cursor of cursors) {
      if (!cursor.caughtUp) continue;
      if (cursor.seenUntil === undefined || cursor.seenUntil < until) {
        await ctx.db.patch(cursor._id, { seenUntil: until });
      }
    }
    return null;
  },
});
