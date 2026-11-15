import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { deleteFiles, PERSIST_MEDIA, sameFile, storedFiles } from "./lib/media";
import { assertNamespaced, epochMs } from "./lib/normalize";
import {
  MAX_TEXT_LENGTH,
  vConversationInput,
  vMessageInput,
  vPostInput,
  type MessageInput,
  type PostInput,
} from "./lib/validators";

// Internal mutations connectors call from their sync actions with
// ctx.runMutation(internal.ingest.*, { accountId, ... }). The owning user and
// platform come from the connected account, never from the caller. Dates
// arrive as ISO strings and are stored as epoch milliseconds.

async function loadAccount(ctx: MutationCtx, accountId: Id<"connectedAccounts">) {
  const account = await ctx.db.get(accountId);
  if (!account) throw new Error("Connected account not found");
  if (account.status === "pending" || account.status === "resetting") {
    throw new Error(`Account is ${account.status}; call internal.accounts.verifyIdentity first`);
  }
  return account;
}

// A title is kept only when it is a real one: never empty, and never the
// author's name or handle standing in for one.
function realTitle(title: string | undefined, author: PostInput["author"]) {
  const trimmed = title?.trim();
  if (!trimmed) return undefined;
  const same = (name: string) => name.trim().toLowerCase() === trimmed.toLowerCase();
  if (same(author.displayName) || same(author.handle) || same(`@${author.handle}`)) return undefined;
  return trimmed;
}

function capText(text: string) {
  if (text.length <= MAX_TEXT_LENGTH) return text;
  const end = /[\uD800-\uDBFF]/.test(text[MAX_TEXT_LENGTH - 1]) ? MAX_TEXT_LENGTH - 1 : MAX_TEXT_LENGTH;
  return text.slice(0, end);
}

function normalizePost(post: Omit<PostInput, "quoted">, platform: string) {
  const { raw: _raw, title, text, createdAt, expiresAt, extracted, ...rest } = post;
  if (rest.platform !== platform) throw new Error(`Post ${rest.id} is not from ${platform}`);
  assertNamespaced(rest.id, platform);
  const event = extracted?.event;
  return {
    ...rest,
    title: realTitle(title, rest.author),
    text: capText(text),
    createdAt: epochMs(createdAt),
    expiresAt: expiresAt === undefined ? undefined : epochMs(expiresAt),
    extracted: extracted && {
      ...extracted,
      event: event && {
        ...event,
        startsAt: event.startsAt === undefined ? undefined : epochMs(event.startsAt),
      },
    },
  };
}

function normalizeMessage(message: MessageInput, platform: string) {
  const { raw: _raw, ...rest } = message;
  assertNamespaced(rest.id, platform);
  assertNamespaced(rest.conversationId, platform);
  return { ...rest, sentAt: epochMs(rest.sentAt) };
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
    const now = Date.now();
    for (const { quoted, ...post } of posts) {
      const doc = normalizePost(post, platform);
      const existing = await ctx.db
        .query("posts")
        .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", doc.id))
        .unique();
      // Files already copied for the same media or avatar carry over.
      const media = doc.media.map((m) => {
        const storageId = existing?.media.find((p) => p.storageId && sameFile(p.url, m.url))?.storageId;
        return storageId ? { ...m, storageId } : m;
      });
      const previous = existing?.author;
      const keepAvatar =
        previous?.avatarStorageId !== undefined &&
        previous.avatarUrl !== undefined &&
        doc.author.avatarUrl !== undefined &&
        sameFile(previous.avatarUrl, doc.author.avatarUrl);
      const row: Omit<Doc<"posts">, "_id" | "_creationTime"> = {
        userId,
        ...doc,
        author: keepAvatar ? { ...doc.author, avatarStorageId: previous.avatarStorageId } : doc.author,
        media,
        quoted: quoted ? normalizePost(quoted, quoted.platform) : undefined,
        fetchedAt: existing?.fetchedAt ?? now,
        updatedAt: now,
      };
      let postId: Id<"posts">;
      if (existing) {
        const kept = new Set(storedFiles(row));
        await deleteFiles(ctx, [...new Set(storedFiles(existing))].filter((id) => !kept.has(id)));
        await ctx.db.replace(existing._id, row);
        postId = existing._id;
      } else {
        postId = await ctx.db.insert("posts", row);
      }
      const missing =
        row.media.some((m) => m.storageId === undefined) ||
        (row.author.avatarUrl !== undefined && row.author.avatarStorageId === undefined);
      if (PERSIST_MEDIA[platform] && missing) {
        await ctx.scheduler.runAfter(0, internal.media.persist, { postId });
      }
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
        updatedAt: epochMs(conversation.updatedAt),
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
