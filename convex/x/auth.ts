import { ConvexError, v } from "convex/values";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action } from "../_generated/server";
import { requireUserId } from "../lib/auth";
import { vPerson } from "../lib/validators";
import { ConnectorFailure, type Person } from "../../src/connectors/types";
import { OAuthClient, webCrypto } from "../../src/connectors/x/auth";
import { xConfigFromEnv } from "../../src/connectors/x/config";
import { XConnector } from "../../src/connectors/x/connector";
import { createFixtureFetch } from "../../src/connectors/x/mock";

// Finishes the app's X login on the server: the device ran PKCE and got the
// authorization code; this exchanges it (with X_CLIENT_SECRET when the X app
// is a confidential client, with the client id alone when it is public),
// stores the session on the caller's connected account, and starts the
// first sync, which confirms the X identity (verifyIdentity) under the
// account's sync lease, so a sync of a previous session can't write after
// the new one is active. Tokens never go back to the device.
export const connect = action({
  args: { code: v.string(), codeVerifier: v.string(), redirectUri: v.string() },
  returns: v.object({ accountId: v.id("connectedAccounts"), me: vPerson }),
  handler: async (ctx, { code, codeVerifier, redirectUri }): Promise<{ accountId: Id<"connectedAccounts">; me: Person }> => {
    await requireUserId(ctx);
    try {
      const config = xConfigFromEnv(process.env);
      const fetchImpl = process.env.X_FIXTURES === "1" ? createFixtureFetch() : fetch;
      const oauth = new OAuthClient({ clientId: config.clientId, clientSecret: config.clientSecret, fetch: fetchImpl, crypto: webCrypto, now: Date.now });
      let session = await oauth.exchangeCode(code, codeVerifier, redirectUri);
      const x = new XConnector({ config, fetch: fetchImpl, onSessionRefreshed: (next) => (session = next as typeof session) });
      const { me } = await x.account(session);
      const accountId: Id<"connectedAccounts"> = await ctx.runMutation(api.accounts.connect, { session });
      await ctx.scheduler.runAfter(0, internal.x.sync.syncAccount, { accountId });
      return { accountId, me: me as Person };
    } catch (err) {
      if (err instanceof ConnectorFailure) throw new ConvexError(err.error);
      throw err;
    }
  },
});
