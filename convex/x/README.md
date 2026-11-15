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

X Chat messages are end-to-end encrypted with keys that only the user's X Chat passcode unlocks. By default the server decrypts them: the user enters the passcode once, the server unlocks the private keys with it, and only the keys are kept, encrypted. X Chat then syncs in the background like legacy DMs, into the same `conversations` and `messages` rows, so the inbox needs no special path.

### API for the app

| Function | What it does |
| --- | --- |
| `api.x.chatNode.setPasscode({ passcode })` (action) | Checks the passcode with X (Juicebox). If X accepts it, exports the unlocked keys and saves them sealed, then decrypts the X Chat rows already in the inbox. Returns `{ ok: true }` or `{ ok: false, error }`, where `error` is `{ kind: "wrongPasscode", guessesRemaining? }` (`guessesRemaining` only when X reports it), `{ kind: "notSetUp" }` (no X Chat passcode on this X account yet; set one in the X app), `{ kind: "notConnected" }` or `{ kind: "failed", message }`. A wrong passcode is never saved. |
| `api.x.chatKeys.removePasscode()` (mutation) | Deletes the saved keys. Messages already decrypted stay; new X Chat messages show as locked until a passcode is set again. |
| `api.x.chatKeys.passcodeStatus()` (query) | `{ status: "none" \| "active" \| "invalid", reason? }`. `"invalid"` means X stopped accepting the saved keys (the user changed their X Chat passcode or keys in the X app), so the app should ask again. |
| `api.messages.send` | Unchanged. For an X Chat conversation with active keys it encrypts on the server and posts through X Chat (`x/send:message` → `x/chatNode:send`), using one daily write. |

X allows 20 wrong passcode tries before it deletes the user's key backup. The server only tries a passcode inside `setPasscode`, when the user types it; it never retries one on its own, and background work uses the saved keys and never calls Juicebox.

### How it works

- **Keys** (`chatNode.ts`, `"use node"`, X's `@xdevplatform/chat-xdk-server`): `setPasscode` reads the account's Juicebox config (`GET /2/users/{id}/public_keys`), unlocks with the passcode, calls `exportKeys`, and seals the bytes with AES-256-GCM. The key comes from `X_CHAT_KEY_ENCRYPTION_KEY`, and the account id and X identity are bound in as additional data. The result goes to `x_chat_keys`. The passcode is zeroed and never stored. Decrypt and send runs open the seal and `importKeys`. The saved keys are deleted by `removePasscode`, by `accounts.disconnect`, and when the X identity behind the account changes. No public function returns them, and nothing logs them.
- **Sync**: `crons.ts` runs `x/chat:syncAll` every 6 hours. `syncAccount` lists up to `CHAT_LIST_LIMIT` conversations (`GET /2/chat/conversations`). `x_sync_state.chatSince` moves only once a listing pass completes, and a pass cut short resumes from `chatCursor`. Changed conversations go to `chatNode.decryptConversations` when the account has active keys, and are otherwise written as `unavailable: { reason: "locked" }` rows. For up to 10 conversations per run, it fetches new events (`GET /2/chat/conversations/{id}/events`, resumable per conversation in `x_chat_cursors`) into `x_chat_events`, decrypts the newest 200 stored events, and upserts the messages and the conversation's `lastMessage`. Rows it can't decrypt stay locked.
- **Ciphertext stays the source**: `x_chat_events` keeps every event exactly as X sent it, so re-decrypting never pays X again.
- **Public keys**: participants' signing keys are cached in `x_chat_public_keys` for 7 days, and the user's own keys for 1 day. If X lists a newer own key version than the saved one, the saved keys are marked `invalid` and no longer used.
- **Phone path**: the on-phone engine (`src/xchat/`, a hidden WebView running `@xdevplatform/chat-xdk`) still works for rows the server hasn't decrypted, and `x/chat:events`, `x/chat:fetchEvents`, `x/chat:keyContext` and `x/chat:send` still serve it. Face ID unlock there is now off by default.
- Nothing ever calls `POST /2/users/{id}/public_keys`, which would rotate the user's X Chat identity.
- `src/connectors/x/chat/__tests__/no-secrets.test.ts` enforces the boundary:
  - only `convex/x/chatNode.ts` may take a passcode or handle private keys;
  - only it, `chatKeys.ts` and the schema touch the sealed keys;
  - no server file logs them.

Chat event reads (event pages and public keys) come out of `chatEventReads` in the budget below, and X Chat sends come out of `writes`.

### Consent

Show this, final, before the passcode is first entered (onboarding after Connect X, and Settings). The same copy is in `src/xchat/consent.ts`.

> **Read your encrypted X chats in Fomovoider**
>
> - X Chat is end-to-end encrypted. To show and send those chats in Fomovoider, we need your X Chat passcode once.
> - We check the passcode with X and use it to unlock your X Chat keys. Fomovoider then stores those keys on its servers, encrypted, to read and send your X Chat messages. We don't store the passcode itself.
> - Your X chats then sync in the background like your other messages, and the decrypted messages are kept in your Fomovoider inbox.
> - Anyone who got those keys could read your X chats, past and future, and send messages as you. Fomovoider keeps them encrypted and never shows them to anyone, including you.
> - X allows 20 wrong passcode tries. After that, X deletes your key backup and you may lose access to older encrypted messages. We only try a passcode when you enter it, never again on our own.
> - You can remove the saved keys at any time in Settings, and they're deleted when you disconnect X. If you change your X Chat passcode or keys in the X app, you'll be asked for it again.
>
> ☐ I agree that Fomovoider stores my X Chat keys on its servers to read and send my X Chat messages.

## Sending (legacy DMs and replies)

Sends happen only when a person taps send in the app; the sync never posts. Each send uses one of the daily `writes` (`X_DAILY_WRITE_BUDGET`) and is upserted right away, so the inbox and feed show it before the next sync. Failures are `ConvexError`s carrying a `ConnectorError`.

- `internal.x.send.message({ accountId, conversationId, text })` sends a legacy DM (`POST /2/dm_conversations/{id}/messages`), stores it with `ingest.upsertMessages`, moves the conversation's preview and order to it with `x/state:markSent` (unless a newer message is already there) and returns the `Message`. It is internal on purpose: the app's single send path, `messages.send`, checks that the user owns the account and conversation and calls it for X. X refusing a conversation that has moved to encrypted X Chat is a `platform` error, and the write is given back.
- `api.x.send.reply({ postId, text })` replies to one of the signed-in user's synced posts and returns `{ id, createdAt, permalink }`. It checks the caller is signed in and owns both the X account and the post, which must be an X post, so nothing is reserved for a target X can't take. X only accepts replies to posts that @mention the user or quote one of their posts; its 403 for any other post becomes a `platform` error saying so.
- An expired account fails with `session_expired` before any X call; an account still being set up fails with a `platform` error.

## Env (Convex deployment)

| Var | |
| --- | --- |
| `X_CLIENT_ID` | Required. |
| `X_CLIENT_SECRET` | Only for a confidential X app. |
| `X_CHAT_KEY_ENCRYPTION_KEY` | Required for server-side X Chat: 32 random bytes, base64 (`openssl rand -base64 32`). It seals the saved X Chat keys; losing or changing it means every user enters their passcode again. Set it per deployment and never reuse it across deployments. |
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
