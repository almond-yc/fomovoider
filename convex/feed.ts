import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
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
    const seen = cursors.flatMap((c) =>
      c.seenUntil === undefined ? [] : [{ platform: c.platform, seenUntil: c.seenUntil }],
    );
    const result = await ctx.db
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
    const connectorsCaughtUp = await everyConnectorCaughtUp(ctx, userId, cursors);
    // Expired and hidden posts are dropped from the page after it is read, so
    // a page can come back shorter than numItems; reads stay bounded by the
    // page size. The database filter above must stay deterministic: a re-run
    // (after a seen mark, say) with a different filter invalidates the
    // client's cursors, so time-dependent checks like expiry belong here.
    const now = Date.now();
    const visible = [];
    for (const post of result.page) {
      if (post.expiresAt !== undefined && post.expiresAt <= now) continue;
      const state = await ctx.db
        .query("postStates")
        .withIndex("by_userId_and_postId", (q) => q.eq("userId", userId).eq("postId", post._id))
        .unique();
      if (state?.hiddenAt === undefined) {
        visible.push({ ...(await resolvePost(ctx, post)), savedAt: state?.savedAt });
      }
    }
    return {
      ...result,
      page: visible,
      caughtUp: result.isDone && connectorsCaughtUp,
    };
  },
});

async function everyConnectorCaughtUp(
  ctx: QueryCtx,
  userId: Id<"users">,
  cursors: Doc<"feedCursors">[],
) {
  const accounts = await ctx.db
    .query("connectedAccounts")
    .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId))
    .collect();
  return accounts.every(
    ({ platform }) => cursors.find((c) => c.platform === platform)?.caughtUp === true,
  );
}

// feed.page's caughtUp without the posts, for clients whose paginated query
// hook (usePaginatedQuery) keeps only each page's items: the feed is caught up
// when the last page is loaded and this is true.
export const connectorsCaughtUp = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const cursors = await ctx.db
      .query("feedCursors")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId))
      .collect();
    return await everyConnectorCaughtUp(ctx, userId, cursors);
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
