import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { storedFiles } from "../lib/media";
import { deletePost } from "../lib/posts";

const BATCH = 100;

// The frozen iPhone screen-reading driver (hosts/instagram) ids posts with a
// 24-hex-char hash of what it read (hosts/instagram/parse.ts postId). The web
// view uses Instagram's own media pk, which is decimal and about 19 digits, so
// the two can't collide.
const LEGACY_ID = /^instagram:[0-9a-f]{24}$/;

export const isLegacyDriverPost = (post: Pick<Doc<"posts">, "platform" | "id">) =>
  post.platform === "instagram" && LEGACY_ID.test(post.id);

const vCounts = v.object({
  scanned: v.number(),
  posts: v.number(),
  postFacts: v.number(),
  uploads: v.number(),
  files: v.number(),
  keptFiles: v.number(),
});
type Counts = typeof vCounts.type;

// Counts, and unless dryRun deletes, one legacy post with its facts, its
// upload claims and its stored files. A file claimed by a non-legacy post (an
// instagram_uploads row naming another post id) is kept.
async function purge(ctx: MutationCtx, post: Doc<"posts">, counts: Counts, dryRun: boolean) {
  counts.posts++;
  const facts = await ctx.db
    .query("instagram_postFacts")
    .withIndex("by_userId_and_postId", (q) => q.eq("userId", post.userId).eq("postId", post.id))
    .collect();
  counts.postFacts += facts.length;
  const kept = new Set<Id<"_storage">>();
  for (const storageId of storedFiles(post)) {
    const claims = await ctx.db
      .query("instagram_uploads")
      .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
      .collect();
    if (claims.some((c) => !LEGACY_ID.test(c.postId))) {
      kept.add(storageId);
      counts.keptFiles++;
      continue;
    }
    counts.uploads += claims.length;
    if (await ctx.db.system.get(storageId)) counts.files++;
    if (!dryRun) for (const claim of claims) await ctx.db.delete(claim._id);
  }
  if (dryRun) return;
  for (const row of facts) await ctx.db.delete(row._id);
  await deletePost(ctx, {
    ...post,
    author: post.author.avatarStorageId && kept.has(post.author.avatarStorageId) ? { ...post.author, avatarStorageId: undefined } : post.author,
    media: post.media.map((m) => (m.storageId && kept.has(m.storageId) ? { ...m, storageId: undefined } : m)),
  });
}

// Removes the posts the legacy iPhone driver wrote, so only web-view posts
// remain. dryRun counts everything in one pass and changes nothing. A real
// run deletes BATCH posts per mutation and schedules itself for the rest,
// logging each batch's counts; it returns the first batch's.
export const purgeLegacyDriverPosts = internalMutation({
  args: { dryRun: v.boolean(), cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ ...vCounts.fields, done: v.boolean() }),
  handler: async (ctx, { dryRun, cursor = null }) => {
    const counts: Counts = { scanned: 0, posts: 0, postFacts: 0, uploads: 0, files: 0, keptFiles: 0 };
    if (dryRun) {
      for await (const post of ctx.db.query("posts")) {
        counts.scanned++;
        if (isLegacyDriverPost(post)) await purge(ctx, post, counts, true);
      }
      return { ...counts, done: true };
    }
    const page = await ctx.db.query("posts").paginate({ numItems: BATCH, cursor });
    for (const post of page.page) {
      counts.scanned++;
      if (isLegacyDriverPost(post)) await purge(ctx, post, counts, false);
    }
    console.log("purgeLegacyDriverPosts batch", JSON.stringify(counts));
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.instagram.cleanup.purgeLegacyDriverPosts, {
        dryRun: false,
        cursor: page.continueCursor,
      });
    }
    return { ...counts, done: page.isDone };
  },
});
