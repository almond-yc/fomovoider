/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("users.viewer", () => {
  test("is null when signed out", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.users.viewer, {})).toBeNull();
  });

  test("returns the email and no accounts for a new user", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "ada@example.com" }));
    const as = t.withIdentity({ subject: `${userId}|session` });
    expect(await as.query(api.users.viewer, {})).toEqual({ email: "ada@example.com", accounts: [] });
  });

  test("lists only the caller's accounts, with status and never the session", async () => {
    const t = convexTest(schema, modules);
    const [ada, bob] = await t.run(async (ctx) => [
      await ctx.db.insert("users", { email: "ada@example.com" }),
      await ctx.db.insert("users", { email: "bob@example.com" }),
    ]);
    const asAda = t.withIdentity({ subject: `${ada}|session` });
    const asBob = t.withIdentity({ subject: `${bob}|session` });
    const accountId = await asAda.mutation(api.accounts.connect, {
      session: { platform: "x", kind: "oauth", accessToken: "secret" },
    });
    await asBob.mutation(api.accounts.connect, {
      session: { platform: "instagram", kind: "cookies", cookies: [] },
    });

    const pending = await asAda.query(api.users.viewer, {});
    expect(pending?.accounts).toEqual([{ platform: "x", status: "pending" }]);

    const me = { id: "x:1", platform: "x", handle: "ada", displayName: "Ada" };
    await t.mutation(internal.accounts.verifyIdentity, { accountId, me });
    await t.mutation(internal.accounts.recordSync, { accountId });
    const viewer = await asAda.query(api.users.viewer, {});
    expect(viewer?.accounts).toHaveLength(1);
    expect(viewer?.accounts[0]).toMatchObject({ platform: "x", status: "active", me });
    expect(viewer?.accounts[0].lastSyncedAt).toEqual(expect.any(Number));
    expect(JSON.stringify(viewer)).not.toContain("secret");

    await asAda.mutation(api.accounts.disconnect, { platform: "x" });
    expect((await asAda.query(api.users.viewer, {}))?.accounts).toEqual([]);
    expect((await asBob.query(api.users.viewer, {}))?.accounts).toEqual([
      { platform: "instagram", status: "pending" },
    ]);
  });
});
