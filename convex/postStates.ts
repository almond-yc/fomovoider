import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./_generated/server";
import { requireUserId } from "./lib/auth";

// What the signed-in user did with one post. Posts stay write-only for
// connectors; this table holds the user's side. Times are epoch ms.

async function update(
  ctx: MutationCtx,
  postId: Id<"posts">,
  change: (state: { seenAt?: number; openedAt?: number; hiddenAt?: number; savedAt?: number }) => {
    seenAt?: number;
    openedAt?: number;
    hiddenAt?: number;
    savedAt?: number;
  },
) {
  const userId = await requireUserId(ctx);
  const post = await ctx.db.get(postId);
  if (!post || post.userId !== userId) throw new Error("Post not found");
  const state = await ctx.db
    .query("postStates")
    .withIndex("by_userId_and_postId", (q) => q.eq("userId", userId).eq("postId", postId))
    .unique();
  if (state) await ctx.db.patch(state._id, change(state));
  else await ctx.db.insert("postStates", { userId, postId, ...change({}) });
  return null;
}

// The first time the post was on screen; later calls keep it.
export const markSeen = mutation({
  args: { postId: v.id("posts") },
  returns: v.null(),
  handler: async (ctx, { postId }) =>
    await update(ctx, postId, (s) => ({ seenAt: s.seenAt ?? Date.now() })),
});

// The last time the user opened the post (its permalink).
export const markOpened = mutation({
  args: { postId: v.id("posts") },
  returns: v.null(),
  handler: async (ctx, { postId }) => await update(ctx, postId, () => ({ openedAt: Date.now() })),
});

// Hidden posts are left out of feed.page.
export const setHidden = mutation({
  args: { postId: v.id("posts"), hidden: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { postId, hidden }) =>
    await update(ctx, postId, () => ({ hiddenAt: hidden ? Date.now() : undefined })),
});

// Saved posts are kept past the 30-day retention (retention.ts).
export const setSaved = mutation({
  args: { postId: v.id("posts"), saved: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { postId, saved }) =>
    await update(ctx, postId, () => ({ savedAt: saved ? Date.now() : undefined })),
});
