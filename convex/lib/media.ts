import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

// Platforms whose media and avatar URLs expire (signed CDN links). Ingest
// copies their files into Convex file storage in the background. X URLs are
// stable, so X stays off.
export const PERSIST_MEDIA: Record<string, boolean> = {
  instagram: true,
  x: false,
};

// Instagram signs its CDN URLs in the query string, and the signature changes
// on every fetch. Comparing without it keeps a stored copy across re-syncs.
export function sameFile(a: string, b: string) {
  return a.split(/[?#]/)[0] === b.split(/[?#]/)[0];
}

export function storedFiles(post: Pick<Doc<"posts">, "author" | "media">): Id<"_storage">[] {
  return [post.author.avatarStorageId, ...post.media.map((m) => m.storageId)].filter(
    (id): id is Id<"_storage"> => id !== undefined,
  );
}

export async function deleteFiles(ctx: MutationCtx, ids: Id<"_storage">[]) {
  for (const id of ids) {
    if (await ctx.db.system.get(id)) await ctx.storage.delete(id);
  }
}

// A post as public queries return it: stored copies win over the platform's
// URLs, which are the fallback when no copy exists (or it was deleted).
export async function resolvePost(ctx: QueryCtx, post: Doc<"posts">) {
  const { avatarStorageId, ...author } = post.author;
  const avatarUrl = avatarStorageId ? await ctx.storage.getUrl(avatarStorageId) : null;
  const media = await Promise.all(
    post.media.map(async ({ storageId, ...m }) => {
      const url = storageId ? await ctx.storage.getUrl(storageId) : null;
      return url ? { ...m, url } : m;
    }),
  );
  return { ...post, author: avatarUrl ? { ...author, avatarUrl } : author, media };
}
