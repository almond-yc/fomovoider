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
- `x_chat_events`: encrypted X Chat events and conversation key changes, stored exactly as X sent them (ciphertext only).
- `x_chat_cursors`: per X Chat conversation, the event sync position.

## X Chat (encrypted DMs)

X Chat messages are end-to-end encrypted with keys that only the user's X Chat passcode unlocks. Decryption happens on the phone; Convex only moves ciphertext.

- `crons.ts` runs `x/chat:syncAll` every 6 hours. `syncAccount` lists up to `CHAT_LIST_LIMIT` conversations (`GET /2/chat/conversations`) and upserts each as a normal inbox row with `unavailable: { reason: "locked" }` and no message text. `x_sync_state.chatSince` moves to the newest conversation only once a listing pass is complete; a pass cut off by the limit or budget resumes from `chatCursor` on the next run.
- When the user opens a conversation, the app calls `x/chat:fetchEvents` (`GET /2/chat/conversations/{id}/events`, `EVENTS_PER_FETCH` per call) and reads the stored rows reactively through `x/chat:events`. Each conversation's position is in `x_chat_cursors`: a pass runs from the newest event down to `sinceId` (or the start of the chat) across fetches, and `sinceId` moves only when the pass ends, so bounded fetches never leave gaps.
- `x/chat:keyContext` returns the Juicebox recovery config for the user's newest key and the participants' public keys (`GET /2/users/{id}/public_keys`). It never calls `POST /2/users/{id}/public_keys`, which would rotate the user's X Chat identity.
- On the phone, `src/xchat/XChatProvider.tsx` runs X's Chat XDK in a hidden WebView (`assets/xchat/engine.html`, rebuilt by `npm run x:chat-engine`). It is mounted by `app/x-chat/_layout.tsx`. The passcode recovers the private key through Juicebox in that WebView; the key and the plaintext stay in its memory and are gone when the user locks X Chat or leaves its screens.
- Face ID or fingerprint unlock is on by default: after the first passcode entry the passcode is kept in the iOS Keychain or Android Keystore behind biometrics (`expo-secure-store`, this device only). The switch in X Chat settings turns it off and deletes the saved passcode.
- `x/chat:send` posts a message the phone already encrypted and signed (`POST /2/chat/conversations/{id}/messages`).
- `purgeOrphans` deletes stored events whose user no longer has that X identity connected.
- `src/connectors/x/chat/__tests__/no-secrets.test.ts` fails if code in `convex/` or `src/connectors/x/chat` ever handles a passcode, a private key or plaintext.

Chat event reads come out of `chatEventReads` in the budget below.

## Env (Convex deployment)

| Var | |
| --- | --- |
| `X_CLIENT_ID` | Required. |
| `X_CLIENT_SECRET` | Only for a confidential X app. |
| `X_DAILY_BUDGET_SPLIT_USD` | Daily dollars per kind, e.g. `chatEventReads=0.30,postReads=0.20`. Kinds not named keep the default split below. |
| `X_DAILY_POST_READ_BUDGET`, `X_DAILY_DM_EVENT_READ_BUDGET`, `X_DAILY_CHAT_EVENT_READ_BUDGET`, `X_DAILY_WRITE_BUDGET` | Counts per X user per UTC day; each one overrides the split for its kind. Defaults 40, 10, 30, 3. |
| `X_FIXTURES` | `1` answers every X call from the connector's fixtures. Local backends only; never set it on a shared deployment. |

## Spend

The default split, per X user per UTC day (`DEFAULT_DAILY_BUDGET_SPLIT_USD` in `src/connectors/x/config.ts`):

| Kind | Unit price | Share | Units |
| --- | --- | --- | --- |
| X Chat event reads (`chatEventReads`) | $0.010 (assumed, see below) | $0.30 | 30 |
| Feed post reads (`postReads`) | $0.005 | $0.20 | 40 |
| Legacy DM event reads (`dmEventReads`) | $0.010 | $0.10 | 10 |
| Writes (`writes`, including X Chat sends) | $0.015 | $0.045 | 3 |
| **Total** | | **$0.645** | $19.995 in a 31-day month |

That stays inside the $20 free credits. X publishes no X Chat price yet, so chat event reads are budgeted at the legacy DM event price. Prices may change; `x_usage` shows what was used.
