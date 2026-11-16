import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { deleteFiles, storedFiles } from "./media";

// Deletes a post with its stored media files, every user's state for it, and
// its Morning Brief verdict and items.
export async function deletePost(ctx: MutationCtx, post: Doc<"posts">) {
  await deleteFiles(ctx, storedFiles(post));
  const states = await ctx.db
    .query("postStates")
    .withIndex("by_postId", (q) => q.eq("postId", post._id))
    .collect();
  for (const state of states) await ctx.db.delete(state._id);
  for (const table of ["brief_verdicts", "brief_items"] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_postId", (q) => q.eq("postId", post._id))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  }
  await ctx.db.delete(post._id);
}
