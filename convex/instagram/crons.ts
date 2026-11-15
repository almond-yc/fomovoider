import type { Crons } from "convex/server";
import { internal } from "../_generated/api";

export function registerInstagramCrons(crons: Crons) {
  crons.daily("instagram plan scheduled runs", { hourUTC: 6, minuteUTC: 0 }, internal.instagram.schedule.planDay, {});
}
