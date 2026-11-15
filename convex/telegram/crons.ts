import type { Crons } from "convex/server";
import { internal } from "../_generated/api";

// Telegram: chats only. Polling every 5 minutes; real-time delivery needs a
// long-lived connection (the bridge host), see README.md.
export function registerTelegramCrons(crons: Crons) {
  crons.interval("telegram:sync accounts", { minutes: 5 }, internal.telegram.state.syncAll, {});
  crons.interval("telegram:clean up sessions", { hours: 1 }, internal.telegram.state.cleanup, {});
}
