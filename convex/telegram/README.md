# Telegram on Convex

The Telegram sync for Fomovoider: chats only. It runs the connector core in `src/connectors/telegram/` with its GramJS transport inside Convex `"use node"` actions, and it writes only through the shared functions in `convex/README.md`.

## Flow

1. **Connect.** The app drives the `steps` Login over three public actions in `login.ts`. `start({ method: "qr" })` or `start({ method: "phone", phone })` returns the first step; `next({ answer? })` answers it (no answer polls a QR code); `cancel()` drops the login. Between rounds, the half-finished login (its session string already holds an auth key) is kept encrypted in `telegram_logins` for 10 minutes. On success the action stores the session encrypted in `telegram_sessions`, checks that the row belongs to the signed-in user, calls `internal.accounts.connectDevice({ userId, platform: "telegram", deviceId: <that row> })`, and schedules a sync. The public `accounts.connect` refuses device sessions (fomovoider#14). Failures throw a `ConvexError` whose `data` is a `ConnectorError`; a wrong code or password keeps the step.
2. **Sync.** `crons.ts` (registered from the root `convex/crons.ts`) runs `telegram/state:syncAll` every 5 minutes, and it schedules `telegram/sync:syncAccount` per account. The app can also call `telegram/state:requestSync` (at most every 30 seconds) when the Chats tab opens or on pull to refresh.
3. `syncAccount`:
   - takes a per-account lease, so the cron and app requests never sync one account twice at once;
   - only uses a `telegram_sessions` row that belongs to the account's own user. this is the second half of the ownership rule, so an account that ends up pointing at another user's session (a bug anywhere upstream) still can't read it;
   - for a pending account, calls `account()` and `internal.accounts.verifyIdentity` first;
   - reads the chat list page by page until it has 50 supported chats or has read 5 pages of Telegram dialogs. The dialogs include broadcast channels, which are left out, so a page can yield no chats at all.
   - updates up to 15 chats a run whose history moved past their checkpoint in `telegram_history`, or whose preview changed. It counts history by Telegram's newest message number, service messages included, so a pin or join still triggers a fetch. A chat seen for the first time brings its newest 20 messages; a known one brings everything after its checkpoint. A catch-up stops at 200 messages a run and resumes from the saved cursor on the next run. The checkpoint moves only after the messages are stored, and the previews `send` and `markRead` write never move it. Unchanged chats aren't rewritten, so the app's subscriptions don't churn;
   - drops the debugging `raw` before every Convex call (GramJS byte fields can't cross it);
   - records success or the `ConnectorError` with `accounts.recordSync`, unless the user reconnected meanwhile (`sessionVersion` moved). A stale error would otherwise clear the new session's `pending` and skip its identity check. On `FLOOD_WAIT` it holds the lease until Telegram's retry time, so no sync runs before then.
4. **Send and read.** These are for the app's send path (`messages.send`/`markRead`, owned by the inbox work): `internal.telegram.sync.send({ accountId, conversationId, text })` and `internal.telegram.sync.markRead({ accountId, conversationId })`. Each returns `{ ok: true, ... }` or `{ ok: false, error: ConnectorError }`, stores the sent message, and refreshes the conversation's unread count. A send runs once and is never retried.
5. **Cleanup.** Every hour `telegram/state:cleanup` drops expired logins. It also logs out (`auth.logOut`) and deletes sessions no account points to anymore (after `accounts.disconnect`, or after a reconnect replaced them), after a 10-minute grace period. So the session also disappears from the person's Settings → Devices in Telegram.

## Tables (`schema.ts`, spread into `convex/schema.ts`)

- `telegram_sessions`: per login, the session string, encrypted. It is the `deviceId` target. No public function returns it.
- `telegram_logins`: per user, the login in progress, encrypted.
- `telegram_peers`: per session, the access hashes Telegram needs to address users and supergroups.
- `telegram_history`: per session and conversation, how far its history is stored (`syncedThrough`), plus an unfinished catch-up (`pendingTop`, `pendingCursor`).
- `telegram_sync_locks`: per account, the sync lease (or the `FLOOD_WAIT` hold) and the last app request.

## Env (Convex deployment)

| Var | |
| --- | --- |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | Required. From my.telegram.org → API development tools. |
| `TELEGRAM_SESSION_KEY` | Required. 32 random bytes, base64 (`openssl rand -base64 32`). It encrypts the session strings at rest with AES-256-GCM, so a data export or the dashboard doesn't expose logins. Changing it disconnects every Telegram account. |
| `TELEGRAM_FIXTURES` | `1` answers every Telegram call from the connector's fixtures (phone code `12345`, 2FA password `hunter2`). Local backends only; never set it on a shared deployment. |

## Polling vs real time

Polling every 5 minutes is good enough for a calm inbox, and it's the product's intent: no pings, check when you open it. A run costs one MTProto connection (about 1.5 s to connect from a Convex Node action in a local test), one `messages.getDialogs` and one `messages.getHistory` per changed chat. Those are ordinary client calls, far below Telegram's flood limits. Reconnecting from the stored session doesn't create a new login.

It is **not** real time. Messages arrive up to 5 minutes late (sooner with `requestSync`), and edits and deletions of older messages aren't picked up. Telegram delivers real-time updates only over a live connection (`updates`, plus `updates.getDifference` after a gap), and Convex actions can't hold one. Real-time delivery, push notifications on new messages, and catching edits and deletions need the **bridge host**: a long-lived process that keeps each session connected and calls ingest as updates arrive. The connector core and the encrypted session table carry over unchanged; only the process that holds the connection moves.

## Not in v1

Media download and upload, secret chats (device-bound, never listed by the API), the archive folder, forum topics and group member lists.
