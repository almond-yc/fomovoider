import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { Session } from "../../src/connectors/types";
import { xConfigFromEnv } from "../../src/connectors/x/config";
import { XChatClient } from "../../src/connectors/x/chat";
import { convexUsageStore } from "./sync";

export type XChatConnection = ReturnType<typeof connectXChat>;

// An X Chat client on an account's session. A refreshed session is saved
// only while the account still holds the session this action started with;
// if the user reconnected meanwhile, the save is refused and the action fails
// instead of overwriting the new one.
// backfill: a one-off run (chatNode.backfill) that spends its own explicit
// read cap, counted under its own usage keys, instead of the daily budget.
export function connectXChat(ctx: ActionCtx, account: Doc<"connectedAccounts">, backfill?: { runId: string; maxReads: number }) {
  let session = account.session as Session;
  let saving: Promise<unknown> = Promise.resolve();
  let sessionVersion = account.sessionVersion ?? 0;
  const usage = convexUsageStore(ctx);
  const runKey = (key: string) => `backfill:${backfill?.runId}:${key.replace(/:\d{4}-\d{2}-\d{2}$/, "")}`;
  const client = new XChatClient({
    config: xConfigFromEnv(
      backfill
        ? new Proxy(process.env, { get: (env, name) => (name === "X_DAILY_CHAT_EVENT_READ_BUDGET" ? String(backfill.maxReads) : env[name as string]) })
        : process.env,
    ),
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
  return { client, session: () => session, saving: () => saving };
}
