import type { Crons } from "convex/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { isDispatchTime, localTime, resolveTimeZone } from "./time";
import { startBrief } from "./workflow";

export function registerBriefCrons(crons: Crons) {
  crons.hourly("brief:dispatch", { minuteUTC: 30 }, internal.brief.crons.dispatch, {});
}

// Starts today's brief for every onboarded user whose local time is 6:30
// (time.ts), at most once per user and local date.
export const dispatch = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    let started = 0;
    for await (const user of ctx.db.query("users")) {
      if (user.onboardedAt === undefined) continue;
      const timeZone = resolveTimeZone(user.timeZone);
      if (!isDispatchTime(now, timeZone)) continue;
      if (await startBrief(ctx, user._id, localTime(now, timeZone).date, timeZone)) started += 1;
    }
    return started;
  },
});

// For development (npx convex run brief/crons:startNow): today's brief for
// one user, whatever the time. Still once per local date.
export const startNow = internalMutation({
  args: { userId: v.id("users") },
  returns: v.union(v.id("brief_runs"), v.null()),
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User not found");
    const timeZone = resolveTimeZone(user.timeZone);
    return await startBrief(ctx, userId, localTime(Date.now(), timeZone).date, timeZone);
  },
});
