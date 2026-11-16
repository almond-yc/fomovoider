import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { listAccounts, vAccountView } from "./accounts";
import { requireUserId } from "./lib/auth";
import { MAX_SLOP_DESCRIPTION_LENGTH } from "./lib/validators";

// The signed-in user, their onboarding answer and their connected accounts,
// or null when signed out. The app gates on it (no onboardedAt: the slop
// screen; no connected account: the Connect screen) and the Settings page
// lists it. Unlike accounts.list it doesn't throw when signed out, so it stays
// safe to subscribe to across sign-in and sign-out.
export const viewer = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      email: v.optional(v.string()),
      slopDescription: v.optional(v.string()),
      onboardedAt: v.optional(v.number()),
      accounts: v.array(vAccountView),
    }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const user = await ctx.db.get(userId);
    if (!user) return null;
    return {
      email: user.email,
      slopDescription: user.slopDescription,
      onboardedAt: user.onboardedAt,
      accounts: await listAccounts(ctx, userId),
    };
  },
});

// Saves the onboarding answer. The first save also stamps onboardedAt;
// later edits keep it.
export const setSlop = mutation({
  args: { slopDescription: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const slopDescription = args.slopDescription.trim();
    if (slopDescription === "") throw new Error("slopDescription is empty");
    if (slopDescription.length > MAX_SLOP_DESCRIPTION_LENGTH) {
      throw new Error(`slopDescription is longer than ${MAX_SLOP_DESCRIPTION_LENGTH} characters`);
    }
    const user = await ctx.db.get(userId);
    if (user === null) throw new Error("User not found");
    await ctx.db.patch(userId, {
      slopDescription,
      onboardedAt: user.onboardedAt ?? Date.now(),
    });
    return null;
  },
});
