import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

// One flag that stops every Instagram refresh at once: web-view refreshes are
// refused and running ones abort, the host agent gets "paused", and no
// scheduled runs are planned. From the CLI:
//   npx convex run instagram/killSwitch:set '{"enabled":true,"reason":"checkpoint seen"}'
export const set = internalMutation({
  args: { enabled: v.boolean(), reason: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { enabled, reason }) => {
    const flag = await ctx.db
      .query("instagram_flags")
      .withIndex("by_name", (q) => q.eq("name", "killSwitch"))
      .unique();
    const doc = { name: "killSwitch" as const, enabled, reason, updatedAt: Date.now() };
    if (flag) await ctx.db.replace(flag._id, doc);
    else await ctx.db.insert("instagram_flags", doc);
    return null;
  },
});
