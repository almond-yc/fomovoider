import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { killSwitch } from "./instagram/common";
import { requireUserId } from "./lib/auth";
import { vPlatform } from "./lib/validators";

// Which connected platforms still have more to sync, read from the sync state
// the connectors keep, so the app can say "Syncing more…" until the backend
// says otherwise. feed: the account's first sync hasn't finished, or its last
// sync left older posts unread (feedCursors.caughtUp false or no cursor yet).
// chats: the first sync hasn't finished, or a DM pass is part way through.
// Expired and failing accounts are left out: nothing is syncing for them, and
// the app shows why instead.
export const status = query({
  args: {},
  returns: v.object({ feed: v.array(vPlatform), chats: v.array(vPlatform) }),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const accounts = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId))
      .collect();
    const instagramOff = (await killSwitch(ctx)) !== null;
    const feed: string[] = [];
    const chats: string[] = [];
    for (const account of accounts) {
      if (account.status === "expired" || account.status === "error") continue;
      if (account.platform === "instagram" && instagramOff) continue;
      const firstSync = account.status === "pending" || account.status === "resetting";
      if (firstSync || !(await feedCaughtUp(ctx, userId, account.platform))) feed.push(account.platform);
      if (firstSync || (await chatsSyncing(ctx, account))) chats.push(account.platform);
    }
    return { feed, chats };
  },
});

async function feedCaughtUp(ctx: QueryCtx, userId: Id<"users">, platform: string) {
  const cursor = await ctx.db
    .query("feedCursors")
    .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId).eq("platform", platform))
    .unique();
  return cursor?.caughtUp === true;
}

async function chatsSyncing(ctx: QueryCtx, account: Doc<"connectedAccounts">) {
  if (account.platform === "x") {
    // The legacy DM pass and the X Chat listing run separately, so each must
    // have finished once for this identity. A dmCursor or chatCursor is a
    // later pass cut short; a conversation cursor is an X Chat history fetch
    // that later runs continue.
    const state = await ctx.db
      .query("x_sync_state")
      .withIndex("by_accountId", (q) => q.eq("accountId", account._id))
      .unique();
    if (!state || state.xUserId !== account.me?.id) return true;
    if (!state.dmPassDone || !state.chatPassDone) return true;
    if (state.dmCursor !== undefined || state.chatCursor !== undefined) return true;
    const unfinished = await ctx.db
      .query("x_chat_cursors")
      .withIndex("by_userId_and_conversationId", (q) => q.eq("userId", account.userId))
      .filter((q) => q.and(q.eq(q.field("xUserId"), state.xUserId), q.neq(q.field("cursor"), undefined)))
      .first();
    return unfinished !== null;
  }
  if (account.platform === "instagram") {
    // Only the app's web view reads Instagram DMs. dms:startSync stamps
    // lastSyncAt when it starts loading the inbox (one page, no paging), and
    // an empty inbox submits nothing, so a started load counts as done. A
    // load submitted under another Instagram identity doesn't.
    const device = await ctx.db
      .query("instagram_devices")
      .withIndex("by_userId", (q) => q.eq("userId", account.userId))
      .first();
    if (device?.transport !== "webview") return false;
    const state = await ctx.db
      .query("instagram_dmState")
      .withIndex("by_userId", (q) => q.eq("userId", account.userId))
      .unique();
    if (state?.lastSyncAt === undefined) return true;
    return state.meId !== undefined && state.meId !== account.me?.id;
  }
  return false;
}
