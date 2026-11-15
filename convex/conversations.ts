import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "./_generated/server";
import { sendBlocker } from "./chat/connectors";
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

// One of the caller's conversations, with sendBlocked set when messages.send
// would refuse it (unavailable, platform can't send, account not connected).
// Null when it isn't the caller's.
export const get = query({
  args: { conversationId: v.string() },
  handler: async (ctx, { conversationId }) => {
    const userId = await requireUserId(ctx);
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", conversationId))
      .unique();
    if (!conversation) return null;
    const account = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_userId_and_platform", (q) =>
        q.eq("userId", userId).eq("platform", conversation.platform),
      )
      .unique();
    return { ...conversation, sendBlocked: sendBlocker(conversation, account) ?? undefined };
  },
});
