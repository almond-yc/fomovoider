import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireUserId } from "./lib/auth";

// Messages of one of the caller's conversations, newest first.
export const list = query({
  args: { conversationId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { conversationId, paginationOpts }) => {
    const userId = await requireUserId(ctx);
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", conversationId))
      .unique();
    if (!conversation) throw new Error("Conversation not found");
    return await ctx.db
      .query("messages")
      .withIndex("by_userId_and_conversationId_and_sentAt", (q) =>
        q.eq("userId", userId).eq("conversationId", conversationId),
      )
      .order("desc")
      .paginate(paginationOpts);
  },
});
