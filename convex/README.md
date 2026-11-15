# Convex backend

Dev deployment: `groovy-bobcat-759`. The app reads its URL from `EXPO_PUBLIC_CONVEX_URL` (see `.env.example`).

## Shared (App crew)

Everything in `convex/` except `convex/<platform>/`:

- `schema.ts`: Convex Auth tables (`users`, ...), `connectedAccounts` (one per user and platform, holding the connector `Session`), `feedCursors` (per user and platform: connector cursor, `caughtUp`, and `seenUntil`, where the feed ends), `posts`, `conversations`, `messages`. Rows mirror the contract's `Post`, `Conversation`, `Message` and `Person` types plus the owning `userId`. ISO dates are stored normalized (`Date#toISOString`); `raw` is never stored.
- `lib/validators.ts`: validators for the contract types. Import them instead of redefining.
- `auth.ts`: Convex Auth, anonymous sign-in for dev builds.
- Public functions for the app, all scoped to the signed-in user: `feed.page`, `feed.markCaughtUp`, `conversations.list`, `messages.list`, `accounts.list` (never returns sessions), `accounts.connect`, `accounts.disconnect`.

## Connectors own `convex/<platform>/`

Sync actions, crons, token or cookie helpers and relevance scoring live in `convex/x/`, `convex/instagram/`, and so on. A connector never edits shared files; if it needs a shared change, it asks the App crew.

## Functions connectors call

All internal, called with `ctx.runQuery` / `ctx.runMutation` from a sync action. The user and platform always come from `accountId`; items from another platform or without a `<platform>:` id prefix are rejected.

| Function | Use |
| --- | --- |
| `internal.accounts.listByPlatform({ platform })` | Accounts to sync in a cron. |
| `internal.accounts.get({ accountId })` | The account with its `session`. |
| `internal.accounts.saveSession({ accountId, session })` | Persist a refreshed session (`onSessionRefreshed`). |
| `internal.accounts.recordSync({ accountId, me?, error? })` | After a sync: success stamps `lastSyncedAt`; a `ConnectorError` sets status `expired` (`session_expired`) or `error`. |
| `internal.ingest.upsertPosts({ accountId, posts, page? })` | Upsert `Post[]` by id; `page: { cursor, caughtUp }` saves the feed cursor. Read it back from `feedCursors` for the next `since`. |
| `internal.ingest.upsertConversations({ accountId, conversations })` | Upsert `Conversation[]` by id. |
| `internal.ingest.upsertMessages({ accountId, messages })` | Upsert `Message[]` by id. |

## Feed rules

`feed.page` merges every platform newest first, hides posts whose `relevance.score` is below `RELEVANCE_THRESHOLD` (`feed.ts`; unscored posts are shown), and stops at each platform's `seenUntil`. When it returns `isDone`, the app shows "You're all caught up" and calls `feed.markCaughtUp({ until })` with the newest `createdAt` it showed.

## Checks

`npm test` (convex-test), `npx tsc --noEmit -p convex`, `npx convex codegen`.
