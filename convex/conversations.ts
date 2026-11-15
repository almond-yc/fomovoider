import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { requireUserId } from "./lib/auth";

// The unified inbox: conversations from every platform, most recent first.
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const userId = await requireUserId(ctx);
    return await ctx.db
      .query("conversations")
      .withIndex("by_userId_and_updatedAt", (q) => q.eq("userId", userId))
      .order("desc")
      .paginate(paginationOpts);
  },
});
