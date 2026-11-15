/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { MAX_SLOP_DESCRIPTION_LENGTH } from "./lib/validators";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const signUp = async () => {
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
  };
  return { t, signUp };
}

afterEach(() => {
  vi.useRealTimers();
});

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
  test("is null when the user no longer exists", async () => {
    const { t, signUp } = await setup();
    const alice = await signUp();
    await t.run((ctx) => ctx.db.delete(alice.userId));
    expect(await alice.as.query(api.users.viewer, {})).toBeNull();
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

describe("users.setSlop", () => {
  test("rejects signed-out callers", async () => {
    const { t } = await setup();
    await expect(
      t.mutation(api.users.setSlop, { slopDescription: "ragebait" }),
    ).rejects.toThrow("Not signed in");
  });

  test("trims, saves and stamps onboardedAt once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 15));
    const { signUp } = await setup();
    const alice = await signUp();
    expect((await alice.as.query(api.users.viewer, {}))?.onboardedAt).toBeUndefined();
    await alice.as.mutation(api.users.setSlop, { slopDescription: "  ragebait and engagement farming \n" });
    const first = await alice.as.query(api.users.viewer, {});
    expect(first?.slopDescription).toBe("ragebait and engagement farming");
    expect(first?.onboardedAt).toBe(Date.UTC(2026, 10, 15));

    vi.setSystemTime(Date.UTC(2026, 10, 20));
    await alice.as.mutation(api.users.setSlop, { slopDescription: "crypto shilling" });
    const edited = await alice.as.query(api.users.viewer, {});
    expect(edited?.slopDescription).toBe("crypto shilling");
    expect(edited?.onboardedAt).toBe(Date.UTC(2026, 10, 15));
  });

  test("rejects empty and whitespace-only answers", async () => {
    const { signUp } = await setup();
    const alice = await signUp();
    for (const slopDescription of ["", "   ", "\n\t "]) {
      await expect(alice.as.mutation(api.users.setSlop, { slopDescription })).rejects.toThrow(
        "slopDescription is empty",
      );
    }
    expect((await alice.as.query(api.users.viewer, {}))?.onboardedAt).toBeUndefined();
  });

  test("enforces the length limit after trimming", async () => {
    const { signUp } = await setup();
    const alice = await signUp();
    const atLimit = "a".repeat(MAX_SLOP_DESCRIPTION_LENGTH);
    await alice.as.mutation(api.users.setSlop, { slopDescription: `  ${atLimit}  ` });
    expect((await alice.as.query(api.users.viewer, {}))?.slopDescription).toBe(atLimit);
    await expect(
      alice.as.mutation(api.users.setSlop, { slopDescription: `${atLimit}a` }),
    ).rejects.toThrow(`longer than ${MAX_SLOP_DESCRIPTION_LENGTH} characters`);
    expect((await alice.as.query(api.users.viewer, {}))?.slopDescription).toBe(atLimit);
  });

  test("only changes the caller's own user", async () => {
    const { signUp } = await setup();
    const alice = await signUp();
    const bob = await signUp();
    await alice.as.mutation(api.users.setSlop, { slopDescription: "ragebait" });
    const bobViewer = await bob.as.query(api.users.viewer, {});
    expect(bobViewer?.slopDescription).toBeUndefined();
    expect(bobViewer?.onboardedAt).toBeUndefined();
  });
});
