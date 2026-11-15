# X on Convex

The X sync for Fomovoider. It runs the connector core in `src/connectors/x/` (official X API v2, OAuth 2.0 PKCE) inside Convex actions and writes only through the shared functions in `convex/README.md`. It extracts and stores; it does not filter or score. Filtering is the app's job, so `Post.relevance` is left unset.

## Flow

1. The app signs in with `createXLogin({ clientId, exchange })` (`src/connectors/x/login.ts`): the device runs PKCE and passes `{ code, codeVerifier, redirectUri }` to the action `api.x.auth.connect`, which exchanges the code on the server (with `X_CLIENT_SECRET` for a confidential X app, with the client id alone for a public one), stores the session through `accounts.connect` (the account is `pending`), schedules the first sync, which calls `verifyIdentity` under the account's sync lease, and returns `{ accountId, me }`. Tokens never return to the device. Failures are `ConvexError`s carrying a `ConnectorError`.
2. `crons.ts` (registered from the root `convex/crons.ts`) runs `x/sync:syncAll` every 6 hours; it schedules `x/sync:syncAccount` per X account. The app can also call `x/sync:requestSync` (at most every 15 minutes) after connecting or on pull to refresh.
3. `syncAccount`:
   - takes a per-account lease, so the cron and app requests never run two syncs of one account at once;
   - for a pending account, calls `account()` and `internal.accounts.verifyIdentity` first; if the identity changed, it stops and the shared purge runs;
   - syncs every legacy DM, paging newest to older across runs, so history in Convex outlives X's 30-day window; an older page never overwrites a newer conversation;
   - reads the feed (mentions plus home, no replies or reposts) and upserts the normalized posts;
   - refreshes access tokens server-side and saves every rotated session with `accounts.saveSession`, unless the user reconnected meanwhile;
   - records success or the `ConnectorError` with `accounts.recordSync`. Fomovoider's own used-up daily budget is not an error: the step waits for the next UTC day. X refusing because the app's credits are depleted (HTTP 402) is recorded as `budget_exhausted` without `resetsAt`.

## Tables (`schema.ts`, spread into `convex/schema.ts`)

- `x_sync_state`: per account, the DM sync position.
- `x_sync_locks`: per account, the sync lease and the last app request.
- `x_usage`: the connector's daily budget counters, reserved atomically in a mutation.

## Env (Convex deployment)

| Var | |
| --- | --- |
| `X_CLIENT_ID` | Required. |
| `X_CLIENT_SECRET` | Only for a confidential X app. |
| `X_DAILY_POST_READ_BUDGET`, `X_DAILY_DM_EVENT_READ_BUDGET`, `X_DAILY_WRITE_BUDGET` | Default 60, 10, 10 per X user per UTC day. |
| `X_FIXTURES` | `1` answers every X call from the connector's fixtures. Local backends only; never set it on a shared deployment. |

## Spend

At X's pay-per-use prices ($0.005 per post read, $0.01 per DM event, $0.015 per write) the defaults cap one user at $0.55 a day, about $17 a month, inside the $20 free credits. Prices may change; `x_usage` shows what was used.

## Not in v1

Encrypted X Chat (FOMO-13).
