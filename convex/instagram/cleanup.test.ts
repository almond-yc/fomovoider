/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("/convex/**/*.ts");

test("purgeLegacyDriverPosts removes only the iPhone driver's posts, with their facts, uploads and files", async () => {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const deviceId = await ctx.db.insert("instagram_devices", { userId, name: "iPhone", timezone: "UTC", scheduleEnabled: false });
    const runId = await ctx.db.insert("instagram_runs", {
      deviceId,
      trigger: "scheduled",
      scheduledFor: 0,
      state: "done",
      budget: { maxMs: 1, maxPosts: 1, maxStoryFrames: 1 },
    });
    const file = () => ctx.storage.store(new Blob(["jpeg"]));
    const insert = async (
      id: string,
      platform: "instagram" | "x",
      opts: { media?: Id<"_storage">[]; avatar?: Id<"_storage">; facts?: boolean; uploads?: Id<"_storage">[] } = {},
    ) => {
      const handle = platform === "x" ? "bob" : "alice";
      const postId = await ctx.db.insert("posts", {
        userId,
        id,
        platform,
        author: { id: `${platform}:${handle}`, platform, handle, displayName: handle, avatarStorageId: opts.avatar },
        createdAt: Date.now(),
        text: "hi",
        media: (opts.media ?? []).map((storageId) => ({ kind: "image" as const, url: `https://cdn/${storageId}.jpg`, width: 390, storageId })),
        permalink: "https://www.instagram.com/alice/",
        fetchedAt: Date.now(),
        updatedAt: Date.now(),
      });
      if (opts.facts) {
        await ctx.db.insert("instagram_postFacts", { userId, postId: id, runId, sponsored: false, suggested: false, isReel: false });
      }
      for (const storageId of opts.uploads ?? []) await ctx.db.insert("instagram_uploads", { storageId, deviceId, postId: id });
      return postId;
    };

    const shared = await file();
    const captured = await file();
    const legacy = await insert("instagram:d15f996764b0cfc33fcb1fea", "instagram", {
      media: [captured, shared],
      avatar: await file(),
      facts: true,
      uploads: [captured],
    });
    await ctx.db.insert("postStates", { userId, postId: legacy, seenAt: 1 });
    const replaced = await file();
    await ctx.db.insert("instagram_uploads", { storageId: replaced, deviceId, postId: "instagram:d15f996764b0cfc33fcb1fea" });
    await ctx.storage.delete(replaced);
    for (let i = 0; i < 120; i++) {
      await insert(`instagram:${i.toString(16).padStart(24, "a")}`, "instagram", { facts: true });
    }
    const webviewFile = await file();
    await insert("instagram:3512345678901234567", "instagram", { media: [webviewFile, shared], facts: true });
    await ctx.db.insert("instagram_uploads", { storageId: shared, deviceId, postId: "instagram:3512345678901234567" });
    await insert("instagram:3512345678901234568", "instagram", { facts: true });
    await insert("x:d15f996764b0cfc33fcb1fea", "x", { media: [await file()] });
    return { webviewFile, shared };
  });

  const counts = { scanned: 124, posts: 121, postFacts: 121, uploads: 2, files: 2, keptFiles: 1, done: true };
  expect(await t.mutation(internal.instagram.cleanup.purgeLegacyDriverPosts, { dryRun: true })).toEqual(counts);
  expect(await t.run(async (ctx) => (await ctx.db.query("posts").collect()).length)).toBe(124);

  const first = await t.mutation(internal.instagram.cleanup.purgeLegacyDriverPosts, { dryRun: false });
  expect(first.scanned).toBe(100);
  expect(first.done).toBe(false);
  await t.finishAllScheduledFunctions(() => {});

  const left = await t.run(async (ctx) => ({
    posts: (await ctx.db.query("posts").collect()).map((p) => p.id).sort(),
    facts: (await ctx.db.query("instagram_postFacts").collect()).map((f) => f.postId).sort(),
    uploads: (await ctx.db.query("instagram_uploads").collect()).map((u) => u.postId),
    states: (await ctx.db.query("postStates").collect()).length,
    files: (await ctx.db.system.query("_storage").collect()).map((f) => f._id).sort(),
  }));
  expect(left).toEqual({
    posts: ["instagram:3512345678901234567", "instagram:3512345678901234568", "x:d15f996764b0cfc33fcb1fea"],
    facts: ["instagram:3512345678901234567", "instagram:3512345678901234568"],
    uploads: ["instagram:3512345678901234567"],
    states: 0,
    files: expect.arrayContaining([ids.webviewFile, ids.shared]),
  });
  expect(left.files).toHaveLength(3);
});
