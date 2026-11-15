# X connector

Implements the app's `Connector` contract (`src/connectors/types.ts`) for X, using the official X API v2 with OAuth 2.0 Authorization Code + PKCE. It turns X's responses into clean, normalized `Post`, `Conversation` and `Message` objects. Merging, cursors, the finite cutoff, read state, session storage and the UI belong to the app.

The core (`connector.ts`, `http.ts`, `mappers.ts`, `auth.ts`, `budget.ts`, `mock.ts`) has no Node-only, Expo or React Native imports, so it runs in Convex actions, in React Native and in Node tests. `fetch`, PKCE crypto and the budget's usage store are injected. `login.ts` is the only file that imports Expo (expo-auth-session, expo-crypto, expo-web-browser), and nothing in the core imports it.

## Using it in the app

```ts
import { XConnector, xConfigFromEnv } from "./src/connectors/x";
import { createXLogin } from "./src/connectors/x/login";

const clientId = process.env.EXPO_PUBLIC_X_CLIENT_ID!;
const login = createXLogin({ clientId });
const x = new XConnector({
  config: xConfigFromEnv({ X_CLIENT_ID: clientId }),
  login,
  usage: persistentUsageStore,        // e.g. backed by a Convex table, so the daily budget survives restarts
  onSessionRefreshed: (session) => saveSession(session), // persist rotated tokens
});

const session = await login.login(); // opens X in the system browser, returns an oauth Session
const { me } = await x.account(session);
const page = await x.feed(session, { since: lastCursor ?? new Date(Date.now() - 86_400_000).toISOString(), limit: 100 });
```

Mock mode needs no credentials: `createMockXConnector()` returns the same connector backed by the fixtures in `fixtures/`, and its `login.login()` resolves to `MOCK_X_SESSION`. Wire it to `EXPO_PUBLIC_X_MOCK=1` in the app layer.

## What each call does

| Contract call | X endpoint | Notes |
|---|---|---|
| `login.login()` | `x.com/i/oauth2/authorize`, `POST /2/oauth2/token` | Public client (no secret on the device), scopes `tweet.read users.read tweet.write dm.read dm.write offline.access`, redirect `fomovoider://oauth/x`. Returns `{ kind: "oauth", accessToken, refreshToken, expiresAt }`. |
| `account` | `GET /2/users/me` | Validates the session. |
| `feed` | `GET /2/users/:id/mentions`, then `GET /2/users/:id/timelines/reverse_chronological` | Mentions are part of the feed. Replies and reposts are excluded from the home timeline by default (`feedExclude`). |
| `conversations` | `GET /2/dm_events` | X has no conversation list, so conversations are derived from one page of DM events. Legacy DM history covers 30 days. |
| `messages` | `GET /2/dm_conversations/:id/dm_events` | Newest first. |
| `send` | `POST /2/dm_conversations/:id/messages` | Text only (`sendMedia: false`). |
| `reply` | `POST /2/tweets` | Only posts that @mention the user or quote one of their posts (X rule since 2026-02-23). Links are refused unless `allowReplyUrls` is set, because X bills them at $0.20. |

Nothing posts on its own: `send` and `reply` run only when the app calls them, which should only happen after the person taps send. Writes are never retried.

## Normalization

- Ids are namespaced: `x:<id>`. Conversation ids are `x:<dm_conversation_id>`.
- `text` is plain text: t.co links are replaced with their real URLs, links to attached media and to the quoted post are removed, HTML entities are decoded, long posts use the full `note_tweet` text, and the automatic leading `@handles` of a reply are removed.
- Media: photos become `image`, videos use the highest-bitrate MP4 with the thumbnail as `previewUrl` and `durationSec`, GIFs become `gif`. Alt text, width and height are kept.
- A repost is returned as the original post with `repostedBy` set and `createdAt` set to the repost time, so the item sorts where it appeared in the feed. Media of reposted and quoted posts isn't returned: the documented expansions don't include their attachments.
- `quoted` is one level deep. `replyTo` carries the author when X includes it.
- Messages have `isMine`. Conversations exclude the account owner from `participants`.
- `relevance` is not set by the connector itself; the backend sync scores posts.
- `raw` keeps the X object for debugging only.

## Feed cursor

`since` may be an ISO timestamp (first run) or a cursor this connector returned (`x1|<home newest id>|<mentions newest id>|<start time>`). The feed follows X's pagination until nothing newer than `since` remains (`caughtUp: true`), or until `limit` or the daily budget runs out (`caughtUp: false`). The returned cursor always points at the newest post seen, so passing it back next time skips anything left between that call's oldest returned post and `since`. This is intentional for a finite feed.

## Session refresh

Access tokens last 2 hours. The connector refreshes 5 minutes before `expiresAt` or after a 401, uses the new token for the rest of that call, and calls `onSessionRefreshed(newSession)` exactly once so the app can persist it; X may rotate the refresh token. Parallel calls that share one expiring session trigger a single refresh. A failed refresh, a second 401 or a cookie session becomes `session_expired`.

## Errors

Every failure is a `ConnectorFailure` whose `error` is:

- `session_expired`: log in again.
- `rate_limited`: X returned 429, or the endpoint's `x-rate-limit-remaining` is 0. `retryAt` comes from `x-rate-limit-reset`.
- `budget_exhausted`: either the daily budget below is used up (`resetsAt` is the next 00:00 UTC), or X reports no credits left. X doesn't document that response, so HTTP 402, a `usage-capped` problem, or a problem mentioning credits, balance or spending limit counts as out of credits.
- `unsupported`: media in `send` or `reply`.
- `platform`: anything else X refused, with a readable message (for example the summoned-reply rule, a recipient not accepting DMs, or an encrypted X Chat conversation). `cause` holds the HTTP status and X's problem body.
- `network`: the request never reached X. Reads are retried once after a 5xx.

## Cost and daily budget

X API access is pay-per-use. The plan is to run on the **$20 of free credits** X grants when a card is saved, with a **$20 spending cap** in the Developer Console. The defaults keep the worst case under $20 a month:

| Budget (`XConfig`) | Default per day | Unit price | Worst case per day |
|---|---|---|---|
| `dailyPostReadBudget` (feed + mentions + expanded quoted/reposted posts) | 60 | $0.005 ($0.001 for owned mentions) | $0.30 |
| `dailyDmEventReadBudget` | 10 | $0.010 | $0.10 |
| `dailyWriteBudget` (replies $0.010, DMs $0.015) | 10 | up to $0.015 | $0.15 |
| **Total** | | | **$0.55/day, about $17 a month** |

That leaves about $3 for `/2/users/me` ($0.01, once per session per app run) and for expansion billing, which third parties report X starts charging on 2026-11-22 (about $0.01 per included user). docs.x.com does not confirm that report. Expected spend is $10–$17 a month. The trade-off is coverage: a typical home feed produces about 500 posts a day and the default shows the newest 60. Each extra 100 posts a day costs about $15 a month. Budgets count per X user per UTC day. Capacity is reserved atomically before each request (two reads per requested post, to cover expanded quoted or reposted posts) and unused capacity is returned afterwards, so parallel calls can't overspend; the usage store's `reserve` must therefore be atomic. In the feed, mentions and the home timeline are read in the same rounds, so neither stream can use up the budget before the other is read. Pass a persistent `usage` store so the count survives restarts.

## Setup for a live account

1. In the X Developer Console, open the app's user authentication settings. Enable OAuth 2.0, choose type **Native App** (public client, no secret), choose permissions "Read and write and Direct message", and add both callback URLs: `fomovoider://oauth/x` (the app) and `http://127.0.0.1:8787/callback` (the smoke script).
2. Save a card to get the $20 of free credits, and set a $20 spending cap.
3. Set `EXPO_PUBLIC_X_CLIENT_ID` to the app's OAuth 2.0 client ID. The custom scheme needs a development build; Expo Go can't receive `fomovoider://` redirects.

## Tests

`npm test` runs vitest against an injected mock `fetch` serving the fixtures in `fixtures/` (built from docs.x.com examples; see its README). The global `fetch` is stubbed to throw, so tests can't reach the network. `npx tsc --noEmit` typechecks.

## Live smoke test (manual, about $0.02)

`scripts/x-live-smoke.mjs` logs in with PKCE through `http://127.0.0.1:8787/callback`, reads `/2/users/me` and one page of up to 5 mentions, prints them normalized, and exits. Tokens stay in memory. It refuses to run without `X_LIVE=1`:

```sh
X_LIVE=1 X_CLIENT_ID=... npm run x:smoke   # add X_CLIENT_SECRET for a confidential app; X_CALLBACK_URL to change the port
```

## Known gaps

- Unverified live: docs.x.com's guides use `tweet.fields`, `referenced_tweets.id` and `note_tweet`, but its generated OpenAPI reference lists `post.fields`, `referenced_posts` and `note_post`. The connector follows the guides. The smoke script requests the same fields, so its first run settles which one is right.

- `unreadCount` and group `title` are left unset: the X API exposes neither.
- Encrypted X Chat messages aren't visible through `/2/dm_events`. A 1:1 conversation whose other participant receives chats encrypted (`receives_your_chat: "encrypted"`) is returned with `unavailable: { reason: "encrypted" }`, and sending to one fails with a `platform` error that explains this.
- `markRead` isn't implemented, because X has no API for it.
