import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { sameFile } from "./lib/media";

// Copies a post's media and author avatar into Convex file storage, for
// platforms in PERSIST_MEDIA (lib/media.ts) whose URLs expire. Ingest
// schedules it; files that fail to download keep their platform URL.
export const persist = internalAction({
  args: { postId: v.id("posts") },
  returns: v.null(),
  handler: async (ctx, { postId }) => {
    const post = await ctx.runQuery(internal.media.get, { postId });
    if (!post) return null;
    const copy = async (url: string) => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          console.warn(`Media copy for ${post.id} failed with HTTP ${response.status}`);
          return undefined;
        }
        return await ctx.storage.store(await response.blob());
      } catch (error) {
        console.warn(`Media copy for ${post.id} failed: ${String(error)}`);
        return undefined;
      }
    };
    const media: { url: string; storageId: Id<"_storage"> }[] = [];
    for (const { url, storageId } of post.media) {
      if (storageId !== undefined || media.some((m) => m.url === url)) continue;
      const copied = await copy(url);
      if (copied) media.push({ url, storageId: copied });
    }
    const { avatarUrl, avatarStorageId } = post.author;
    const avatarCopy =
      avatarUrl !== undefined && avatarStorageId === undefined ? await copy(avatarUrl) : undefined;
    await ctx.runMutation(internal.media.attach, {
      postId,
      media,
      avatar: avatarUrl && avatarCopy ? { url: avatarUrl, storageId: avatarCopy } : undefined,
    });
    return null;
  },
});

export const get = internalQuery({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => await ctx.db.get(postId),
});

// Links copied files to the post. The post may have been re-ingested or
// deleted while the copy ran, so each file is matched by URL again, and
// files nothing uses any more are deleted.
export const attach = internalMutation({
  args: {
    postId: v.id("posts"),
    media: v.array(v.object({ url: v.string(), storageId: v.id("_storage") })),
    avatar: v.optional(v.object({ url: v.string(), storageId: v.id("_storage") })),
  },
  returns: v.null(),
  handler: async (ctx, { postId, media, avatar }) => {
    const post = await ctx.db.get(postId);
    const used = new Set<Id<"_storage">>();
    if (post) {
      const nextMedia = post.media.map((m) => {
        if (m.storageId !== undefined) return m;
        const copy = media.find((c) => sameFile(c.url, m.url));
        if (!copy) return m;
        used.add(copy.storageId);
        return { ...m, storageId: copy.storageId };
      });
      let author = post.author;
      if (
        avatar &&
        author.avatarStorageId === undefined &&
        author.avatarUrl !== undefined &&
        sameFile(author.avatarUrl, avatar.url)
      ) {
        author = { ...author, avatarStorageId: avatar.storageId };
        used.add(avatar.storageId);
      }
      await ctx.db.patch(postId, { media: nextMedia, author });
    }
    const copies = [...media.map((m) => m.storageId), ...(avatar ? [avatar.storageId] : [])];
    for (const id of copies) if (!used.has(id)) await ctx.storage.delete(id);
    return null;
  },
});
