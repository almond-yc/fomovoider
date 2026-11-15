// Manual, opt-in smoke test of the X connector against the live X API. Spends real credits (about $0.03).
// Usage: X_LIVE=1 X_CLIENT_ID=... npm run x:smoke
import { createServer } from "node:http";
import { OAuthClient, webCrypto } from "../src/connectors/x/auth";
import { xConfigFromEnv } from "../src/connectors/x/config";
import { XConnector } from "../src/connectors/x/connector";
import { API_BASE, MEDIA_FIELDS, POST_EXPANSIONS, POST_FIELDS, USER_FIELDS, paths } from "../src/connectors/x/endpoints";
import { XMapper } from "../src/connectors/x/mappers";

if (process.env.X_LIVE !== "1") {
  console.error("Refusing to call the live X API: set X_LIVE=1 to run this smoke test (it spends credits).");
  process.exit(1);
}

const config = xConfigFromEnv(process.env);
const callbackUrl = new URL(process.env.X_CALLBACK_URL || "http://127.0.0.1:8787/callback");
const oauth = new OAuthClient({ clientId: config.clientId, clientSecret: config.clientSecret, fetch, crypto: webCrypto, now: Date.now });
const auth = await oauth.begin(callbackUrl.toString());

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", callbackUrl);
    if (url.pathname !== callbackUrl.pathname) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" }).end("You can close this tab and return to the terminal.");
    server.close();
    const error = url.searchParams.get("error");
    if (error) reject(new Error(`Authorization failed: ${error}`));
    else if (url.searchParams.get("state") !== auth.state) reject(new Error("State mismatch; aborting"));
    else if (!url.searchParams.get("code")) reject(new Error("No authorization code in callback"));
    else resolve(url.searchParams.get("code"));
  });
  server.listen(Number(callbackUrl.port || 80), callbackUrl.hostname, () => {
    console.log(`Listening on ${callbackUrl}. Open this URL in a browser signed in to X and approve:\n\n${auth.url}\n`);
  });
});

const session = await oauth.exchangeCode(code, auth.codeVerifier, callbackUrl.toString());
const connector = new XConnector({ config });

const { me } = await connector.account(session);
console.log(`/2/users/me: @${me.handle} (${me.id}) ${me.displayName}`);

const userId = me.id.slice(2);
const query = new URLSearchParams({ max_results: "5", "tweet.fields": POST_FIELDS, expansions: POST_EXPANSIONS, "user.fields": USER_FIELDS, "media.fields": MEDIA_FIELDS });
const res = await fetch(`${API_BASE}${paths.mentions(userId)}?${query}`, { headers: { authorization: `Bearer ${session.accessToken}` } });
if (!res.ok) throw new Error(`Mentions request failed with HTTP ${res.status}: ${await res.text()}`);
const body = await res.json();
const mapper = new XMapper(body.includes);
const posts = (body.data ?? []).map((tweet) => mapper.post(tweet));
console.log(`One page of mentions: ${posts.length} post(s)`);
for (const post of posts) console.log(`- @${post.author.handle}: ${post.text.replace(/\s+/g, " ").slice(0, 100)}`);

console.log("\nDone. The session was kept in memory only and is discarded now.");
