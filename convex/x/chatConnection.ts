import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { ConnectorFailure, type Session } from "../../src/connectors/types";
import { xConfigFromEnv } from "../../src/connectors/x/config";
import { XChatClient } from "../../src/connectors/x/chat";
import { convexUsageStore } from "./sync";

export type XChatConnection = ReturnType<typeof connectXChat>;

const REALTIME_READS_PER_DAY = 5;

// The part of the daily chatEventReads budget held back for decrypting
// messages X pushes through the webhook (chatNode.decryptDelivered), so they
// aren't left locked once background sync has used its share. Background
// runs get the rest, so the two never add up to more than the daily budget.
export function realtimeReads(): number {
  const configured = Number(process.env.X_DAILY_CHAT_REALTIME_READ_BUDGET ?? REALTIME_READS_PER_DAY);
  const reads = Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : REALTIME_READS_PER_DAY;
  return Math.min(reads, xConfigFromEnv(process.env).dailyChatEventReadBudget);
}

// An X Chat client on an account's session. A refreshed session is saved
// only while the account still holds the session this action started with;
// if the user reconnected meanwhile, the save is refused and the action fails
// instead of overwriting the new one.
// backfill: a separate read cap counted under its own usage keys instead of
// the daily budget, for a one-off backfill run (chatNode.backfill) or the
// daily real-time reserve webhook decrypts use (runId "realtime:<day>").
export function connectXChat(ctx: ActionCtx, account: Doc<"connectedAccounts">, backfill?: { runId: string; maxReads: number }) {
  let session = account.session as Session;
  let saving: Promise<unknown> = Promise.resolve();
  let sessionVersion = account.sessionVersion ?? 0;
  const usage = convexUsageStore(ctx);
  const runKey = (key: string) => `backfill:${backfill?.runId}:${key.replace(/:\d{4}-\d{2}-\d{2}$/, "")}`;
  const raw = new XChatClient({
    config: backfill
      ? xConfigFromEnv(new Proxy(process.env, { get: (env, name) => (name === "X_DAILY_CHAT_EVENT_READ_BUDGET" ? String(backfill.maxReads) : env[name as string]) }))
      : (() => {
          const config = xConfigFromEnv(process.env);
          return { ...config, dailyChatEventReadBudget: config.dailyChatEventReadBudget - realtimeReads() };
        })(),
    usage: backfill
      ? {
          used: (key) => usage.used(runKey(key)),
          reserve: (key, amount, limit) => usage.reserve(runKey(key), amount, limit),
          release: (key, amount) => usage.release(runKey(key), amount),
        }
      : usage,
    onSessionRefreshed: (next) => {
      session = next;
      saving = saving.then(async () => {
        const result = await ctx.runMutation(internal.accounts.saveSession, {
          accountId: account._id,
          session: next as Doc<"connectedAccounts">["session"],
          expectedVersion: sessionVersion,
        });
        if (!result.saved) throw new Error("X was reconnected while this X Chat request ran; try again");
        sessionVersion = result.sessionVersion;
      });
    },
  });
  // X rejected the session (a 401, or a refresh refused with 400/401): mark
  // the account expired at once so the app shows its reconnect banner,
  // unless the user reconnected meanwhile (messages.expireSession checks the
  // session version).
  const client = new Proxy(raw, {
    get: (target, name, receiver) => {
      const value = Reflect.get(target, name, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          return await value.apply(target, args);
        } catch (err) {
          if (err instanceof ConnectorFailure && err.error.kind === "session_expired") {
            await ctx.runMutation(internal.messages.expireSession, { accountId: account._id, sessionVersion }).catch(() => undefined);
          }
          throw err;
        }
      };
    },
  });
  return { client, session: () => session, saving: () => saving };
}
