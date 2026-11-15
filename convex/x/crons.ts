import type { Crons } from "convex/server";
import { internal } from "../_generated/api";

// X: feed and DMs. Every 6 hours fits the default daily read budget, which
// keeps spend under the $20 of free credits a month (README.md).
export function registerXCrons(crons: Crons) {
  crons.interval("x:sync accounts", { hours: 6 }, internal.x.sync.syncAll, {});
  // X Chat: lists encrypted conversations as locked inbox rows (chat.ts).
  crons.interval("x:sync chat conversations", { hours: 6 }, internal.x.chat.syncAll, {});
  // Webhooks: subscribes new accounts, resumes ones paused by the daily event
  // cap, and drops subscriptions of accounts that went away (webhook.ts).
  crons.interval("x:webhook subscriptions", { hours: 1 }, internal.x.webhook.ensureAll, {});
}
