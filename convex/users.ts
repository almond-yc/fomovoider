import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { query } from "./_generated/server";
import { listAccounts, vAccountView } from "./accounts";

// The signed-in user and their connected accounts, or null when signed out.
// The app gates on it (no connected account: the Connect screen) and the
// Settings page lists it. Unlike accounts.list it doesn't throw when signed
// out, so it stays safe to subscribe to across sign-in and sign-out.
export const viewer = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({ email: v.optional(v.string()), accounts: v.array(vAccountView) }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const user = await ctx.db.get(userId);
    if (!user) return null;
    return { email: user.email, accounts: await listAccounts(ctx, userId) };
  },
});
