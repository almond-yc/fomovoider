import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { assertNamespaced, isoDate } from "./lib/normalize";
import {
  vConversationInput,
  vMessageInput,
  vPostInput,
  type MessageInput,
  type PostInput,
} from "./lib/validators";

// Internal mutations connectors call from their sync actions with
// ctx.runMutation(internal.ingest.*, { accountId, ... }). The owning user and
// platform come from the connected account, never from the caller.

async function loadAccount(ctx: MutationCtx, accountId: Id<"connectedAccounts">) {
  const account = await ctx.db.get(accountId);
  if (!account) throw new Error("Connected account not found");
  if (account.status === "pending" || account.status === "resetting") {
    throw new Error(`Account is ${account.status}; call internal.accounts.verifyIdentity first`);
  }
  return account;
}

function normalizePost(post: Omit<PostInput, "quoted">, platform: string) {
  const { raw: _raw, ...rest } = post;
  if (rest.platform !== platform) throw new Error(`Post ${rest.id} is not from ${platform}`);
  assertNamespaced(rest.id, platform);
  const event = rest.extracted?.event;
  return {
    ...rest,
    createdAt: isoDate(rest.createdAt),
    expiresAt: rest.expiresAt === undefined ? undefined : isoDate(rest.expiresAt),
    extracted:
      event?.startsAt === undefined
        ? rest.extracted
        : { ...rest.extracted, event: { ...event, startsAt: isoDate(event.startsAt) } },
  };
}

function normalizeMessage(message: MessageInput, platform: string) {
  const { raw: _raw, ...rest } = message;
  assertNamespaced(rest.id, platform);
  assertNamespaced(rest.conversationId, platform);
  return { ...rest, sentAt: isoDate(rest.sentAt) };
}

export const upsertPosts = internalMutation({
  args: {
    accountId: v.id("connectedAccounts"),
    posts: v.array(vPostInput),
    // The Page<Post> metadata of this sync, saved as the platform's feed cursor.
    page: v.optional(v.object({ cursor: v.string(), caughtUp: v.boolean() })),
  },
  returns: v.null(),
  handler: async (ctx, { accountId, posts, page }) => {
    const { userId, platform } = await loadAccount(ctx, accountId);
    for (const { quoted, ...post } of posts) {
      const doc = {
        userId,
        ...normalizePost(post, platform),
        quoted: quoted ? normalizePost(quoted, quoted.platform) : undefined,
      };
      const existing = await ctx.db
        .query("posts")
        .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", doc.id))
        .unique();
      if (existing) await ctx.db.replace(existing._id, doc);
      else await ctx.db.insert("posts", doc);
    }
    if (page) {
      const cursor = await ctx.db
        .query("feedCursors")
        .withIndex("by_userId_and_platform", (q) =>
          q.eq("userId", userId).eq("platform", platform),
        )
        .unique();
      if (cursor) await ctx.db.patch(cursor._id, page);
      else await ctx.db.insert("feedCursors", { userId, platform, ...page });
    }
    return null;
  },
});

export const upsertConversations = internalMutation({
  args: {
    accountId: v.id("connectedAccounts"),
    conversations: v.array(vConversationInput),
  },
  returns: v.null(),
  handler: async (ctx, { accountId, conversations }) => {
    const { userId, platform } = await loadAccount(ctx, accountId);
    for (const conversation of conversations) {
      if (conversation.platform !== platform) {
        throw new Error(`Conversation ${conversation.id} is not from ${platform}`);
      }
      assertNamespaced(conversation.id, platform);
      const doc: Omit<Doc<"conversations">, "_id" | "_creationTime"> = {
        userId,
        ...conversation,
        updatedAt: isoDate(conversation.updatedAt),
        lastMessage: conversation.lastMessage
          ? normalizeMessage(conversation.lastMessage, platform)
          : undefined,
      };
      const existing = await ctx.db
        .query("conversations")
        .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", doc.id))
        .unique();
      if (existing) await ctx.db.replace(existing._id, doc);
      else await ctx.db.insert("conversations", doc);
    }
    return null;
  },
});

export const upsertMessages = internalMutation({
  args: {
    accountId: v.id("connectedAccounts"),
    messages: v.array(vMessageInput),
  },
  returns: v.null(),
  handler: async (ctx, { accountId, messages }) => {
    const { userId, platform } = await loadAccount(ctx, accountId);
    for (const message of messages) {
      const doc = { userId, ...normalizeMessage(message, platform) };
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", doc.id))
        .unique();
      if (existing) await ctx.db.replace(existing._id, doc);
      else await ctx.db.insert("messages", doc);
    }
    return null;
  },
});
