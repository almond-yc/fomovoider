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
export function connectXChat(ctx: ActionCtx, account: Doc<"connectedAccounts">) {
  let session = account.session as Session;
  let saving: Promise<unknown> = Promise.resolve();
  let sessionVersion = account.sessionVersion ?? 0;
  const client = new XChatClient({
    config: xConfigFromEnv(process.env),
    usage: convexUsageStore(ctx),
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
