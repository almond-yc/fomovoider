import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { killSwitch } from "./common";
import { RUN_BUDGET, SCHEDULE_JITTER_MS, SCHEDULE_LOCAL_HOURS } from "./limits";

// Minutes east of UTC for a time zone at a given instant.
function offsetMinutes(timeZone: string, at: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((local - Math.floor(at / 60_000) * 60_000) / 60_000);
}

// The local calendar day (in the device's time zone) that starts after "now",
// as UTC instants for each scheduled hour of that day.
export function slotsForNextDay(timeZone: string, now: number) {
  const offset = offsetMinutes(timeZone, now);
  const localNow = new Date(now + offset * 60_000);
  const nextDayUtcMidnight = Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate() + 1,
  );
  return SCHEDULE_LOCAL_HOURS.map((hour) => {
    const localMs = nextDayUtcMidnight + hour * 3_600_000;
    return localMs - offsetMinutes(timeZone, localMs) * 60_000;
  });
}

// Daily cron: plans tomorrow's two scheduled runs per paired, unpaused
// device, each at its local slot +-45 min.
export const planDay = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    let planned = 0;
    if (await killSwitch(ctx)) return planned;
    for await (const device of ctx.db.query("instagram_devices")) {
      if (!device.scheduleEnabled || !device.accountId || !device.tokenHash || device.transport === "webview") continue;
      const slots = slotsForNextDay(device.timezone, now);
      for (const slot of slots) {
        const scheduledFor = slot + Math.round((Math.random() * 2 - 1) * SCHEDULE_JITTER_MS);
        if (device.pausedUntil !== undefined && device.pausedUntil > scheduledFor) continue;
        const already = await ctx.db
          .query("instagram_runs")
          .withIndex("by_deviceId_and_state_and_scheduledFor", (q) =>
            q
              .eq("deviceId", device._id)
              .eq("state", "pending")
              .gte("scheduledFor", slot - SCHEDULE_JITTER_MS)
              .lte("scheduledFor", slot + SCHEDULE_JITTER_MS),
          )
          .first();
        if (already) continue;
        await ctx.db.insert("instagram_runs", {
          deviceId: device._id,
          trigger: "scheduled",
          scheduledFor,
          state: "pending",
          budget: RUN_BUDGET,
        });
        planned++;
      }
    }
    return planned;
  },
});
