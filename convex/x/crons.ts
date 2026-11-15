import type { Crons } from "convex/server";
import { internal } from "../_generated/api";

// X: feed and DMs. Every 6 hours fits the default daily read budget, which
// keeps spend under the $20 of free credits a month (README.md).
export function registerXCrons(crons: Crons) {
  crons.interval("x:sync accounts", { hours: 6 }, internal.x.sync.syncAll, {});
}
