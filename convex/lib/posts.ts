import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { deleteFiles, storedFiles } from "./media";

// Deletes a post with its stored media files and every user's state for it.
export async function deletePost(ctx: MutationCtx, post: Doc<"posts">) {
  await deleteFiles(ctx, storedFiles(post));
  const states = await ctx.db
    .query("postStates")
    .withIndex("by_postId", (q) => q.eq("postId", post._id))
    .collect();
  for (const state of states) await ctx.db.delete(state._id);
  await ctx.db.delete(post._id);
}
