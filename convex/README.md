# Convex backend

Dev deployment: `groovy-bobcat-759`. The app reads its URL from `EXPO_PUBLIC_CONVEX_URL` (see `.env.example`).

## Shared (App crew)

Everything in `convex/` except `convex/<platform>/`:

- `schema.ts`: `sharedTables`, the Convex Auth tables (`users`, ...), `connectedAccounts` (one per user and platform, holding the connector `Session`), `feedCursors` (per user and platform: connector cursor, `caughtUp`, and `seenUntil`, where the feed ends), `posts`, `conversations`, `messages`. Rows mirror the contract's (`src/connectors/types.ts`) `Post`, `Conversation`, `Message` and `Person` types plus the owning `userId`. ISO dates are stored normalized (`Date#toISOString`); `raw` is never stored.
- `lib/validators.ts`: validators for the contract types. Import them instead of redefining.
- `auth.ts`: Convex Auth, anonymous sign-in for dev builds.
- Public functions for the app, all scoped to the signed-in user: `feed.page`, `feed.markCaughtUp`, `conversations.list`, `messages.list`, `accounts.list` (never returns sessions), `accounts.connect`, `accounts.disconnect`.

## Connectors own `convex/<platform>/`

Sync actions, crons, token or cookie helpers and relevance scoring live in `convex/x/`, `convex/instagram/`, and so on. A connector never edits shared files; if it needs a shared change, it asks the App crew.

### Connector-owned tables

A connector that needs tables of its own (devices, rate-limit state, ...) defines them in `convex/<platform>/schema.ts` and prefixes every table name with its platform:

```ts
// convex/instagram/schema.ts
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const instagramTables = {
  instagram_devices: defineTable({ userId: v.id("users"), name: v.string() }),
};
```

It registers them with one import and one spread in `convex/schema.ts`, the only change a connector makes to a shared file:

```ts
import { instagramTables } from "./instagram/schema";

export default defineSchema({
  ...sharedTables,
  ...instagramTables,
});
```

A `device` session holds only a `deviceId` pointing into such a table; device secrets stay there, never in `connectedAccounts`.

## Functions connectors call

All internal, called with `ctx.runQuery` / `ctx.runMutation` from a sync action. The user and platform always come from `accountId`; items from another platform or without a `<platform>:` id prefix are rejected.

| Function | Use |
| --- | --- |
| `internal.accounts.listByPlatform({ platform })` | Accounts to sync in a cron. |
| `internal.accounts.get({ accountId })` | The account with its `session`. |
| `internal.accounts.verifyIdentity({ accountId, me })` | Required while `status` is `pending` (after every `accounts.connect`): pass `account()`'s `me`. A different identity than before drops the old cursor and cached content; the account is `resetting` until the purge finishes. Ingest refuses in both states. |
| `internal.accounts.saveSession({ accountId, session })` | Persist a refreshed session (`onSessionRefreshed`). |
| `internal.accounts.recordSync({ accountId, error? })` | After a sync: success stamps `lastSyncedAt`; a `ConnectorError` sets status `expired` (`session_expired`) or `error`. |
| `internal.ingest.upsertPosts({ accountId, posts, page? })` | Upsert `Post[]` by id, including `format`, `expiresAt` and `extracted`; `page: { cursor, caughtUp }` saves the feed cursor. Read it back from `feedCursors` for the next `since`. |
| `internal.ingest.upsertConversations({ accountId, conversations })` | Upsert `Conversation[]` by id. |
| `internal.ingest.upsertMessages({ accountId, messages })` | Upsert `Message[]` by id. |

## Feed rules

`feed.page` merges every platform newest first, hides items whose `expiresAt` has passed (stories), hides posts whose `relevance.score` is below `RELEVANCE_THRESHOLD` (`feed.ts`; unscored posts are shown), and stops at each platform's `seenUntil`. It returns `caughtUp: true` only on the last page when every connected platform's connector reported `caughtUp` on its latest page; then the app shows "You're all caught up" and calls `feed.markCaughtUp({ until })` with the newest `createdAt` it showed. `markCaughtUp` only moves `seenUntil` for platforms whose connector has caught up, so posts from a platform still paging are never skipped. `accounts.disconnect` deletes the platform's cursor and cached content.

## Checks

`npm test` (convex-test), `npx tsc --noEmit -p convex`, `npx convex codegen`.
