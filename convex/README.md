# Convex backend

Dev deployment: `groovy-bobcat-759`. The app reads its URL from `EXPO_PUBLIC_CONVEX_URL` (see `.env.example`).

## Shared (App crew)

Everything in `convex/` except `convex/<platform>/`:

- `schema.ts`: `sharedTables`, the Convex Auth tables (`users`, ...), `connectedAccounts` (one per user and platform, holding the connector `Session`), `feedCursors` (per user and platform: connector cursor, `caughtUp`, and `seenUntil`, where the feed ends), `posts`, `postStates`, `conversations`, `messages`. Rows mirror the contract's (`src/connectors/types.ts`) `Post`, `Conversation`, `Message` and `Person` types plus the owning `userId`; `raw` is never stored.
- **Dates are epoch milliseconds.** Connectors pass the contract's ISO strings; ingest converts every date (`createdAt`, `expiresAt`, `extracted.event.startsAt`, `sentAt`, `updatedAt`) to epoch ms, and every public query returns epoch ms. Posts also carry `fetchedAt` (first ingest) and `updatedAt` (last upsert). `feed.markCaughtUp({ until })` takes epoch ms too.
- **Posts**: `title` holds real titles only (empty titles and titles equal to the author's name or handle are dropped at ingest). `text` is cut to 10,000 characters. Engagement counts are never stored; the validators reject them.
- **Media**: `media[].width`, `height` and `blurhash` are kept when a connector sends them. For platforms in `PERSIST_MEDIA` (`lib/media.ts`; Instagram on, X off), ingest schedules `internal.media.persist`, which copies each media file and the author's avatar into Convex file storage (`media[].storageId`, `author.avatarStorageId`). A connector that already uploaded a file to Convex storage passes its `media[].storageId` on a post (messages do not take one); ingest checks the file exists, keeps it, and copies nothing. Use one file per post, since retention deletes it with the post. `feed.page` returns the stored copy's URL in `url`/`avatarUrl` and falls back to the platform URL.
- `postStates.ts`: per user and post, `markSeen`, `markOpened`, `setHidden`, `setSaved`, checked against the post's owner. `feed.page` leaves hidden posts out.
- `retention.ts`: the daily `app:retention` cron (registered with `registerAppCrons` in `crons.ts`) deletes posts past `expiresAt` and posts older than 30 days that the user hasn't saved, with their stored files and states.
- `lib/validators.ts`: validators for the contract types. Import them instead of redefining.
- `auth.ts`: Convex Auth, anonymous sign-in for dev builds.
- Public functions for the app, all scoped to the signed-in user: `feed.page`, `feed.markCaughtUp`, `postStates.*`, `conversations.list`, `messages.list`, `accounts.list` (never returns sessions), `accounts.connect`, `accounts.disconnect`.

## Connectors own `convex/<platform>/`

Sync actions, crons, token or cookie helpers and relevance scoring live in `convex/x/`, `convex/instagram/`, and so on. A connector edits no shared file except to register its tables and crons (below); any other shared change goes through the App crew.

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

It registers them with one import and one spread in `convex/schema.ts`, one of the two changes a connector makes to a shared file (the other is its cron registration, below):

```ts
import { instagramTables } from "./instagram/schema";

export default defineSchema({
  ...sharedTables,
  ...instagramTables,
});
```

X registers `xTables` from `convex/x/schema.ts` the same way.

### Connector crons

`convex/crons.ts` is the shared cron registry. Each connector exports a `register<Platform>Crons(crons)` function from `convex/<platform>/crons.ts` that adds its own jobs, and the registry calls one per platform:

```ts
// convex/x/crons.ts
import type { Crons } from "convex/server";
import { internal } from "../_generated/api";

export function registerXCrons(crons: Crons) {
  crons.interval("sync X accounts", { hours: 6 }, internal.x.sync.syncAll, {});
}
```

```ts
// convex/crons.ts
import { cronJobs } from "convex/server";
import { registerXCrons } from "./x/crons";

const crons = cronJobs();
registerXCrons(crons);
export default crons;
```

Prefix job names with the platform so they stay unique. Adding the import and the `register<Platform>Crons(crons)` call is, with the table spread, the only change a connector makes to a shared file.

A `device` session holds only a `deviceId` pointing into such a table; device secrets stay there, never in `connectedAccounts`.

The app cannot store a device session: `accounts.connect` (and `saveSession`) reject `kind: "device"`, because a `deviceId` is only a pointer and the app could point it at another user’s row. The connector stores it from its own pairing code with `internal.accounts.connectDevice({ userId, platform, deviceId })`, and only after it has checked that the device row belongs to `userId`. That check is not a one-off: the connector’s sync path must also confirm, every time it resolves `session.deviceId`, that the device row still belongs to the account’s `userId` before it reads or writes anything with it.

## Functions connectors call

All internal, called with `ctx.runQuery` / `ctx.runMutation` from a sync action. The user and platform always come from `accountId`; items from another platform or without a `<platform>:` id prefix are rejected.

| Function | Use |
| --- | --- |
| `internal.accounts.listByPlatform({ platform })` | Accounts to sync in a cron. |
| `internal.accounts.get({ accountId })` | The account with its `session`. |
| `internal.accounts.connectDevice({ userId, platform, deviceId })` | From pairing code only, after checking the device row is `userId`’s: stores the `device` session (replacing any previous one) and leaves the account `pending` like `accounts.connect`. |
| `internal.accounts.verifyIdentity({ accountId, me })` | Required while `status` is `pending` (after every `accounts.connect`): pass `account()`'s `me`. A different identity than before drops the old cursor and cached content; the account is `resetting` until the purge finishes. Ingest refuses in both states. |
| `internal.accounts.saveSession({ accountId, session, expectedVersion? })` | Persist a refreshed cookie or OAuth session (`onSessionRefreshed`); device sessions are refused, use `connectDevice`. Pass the `sessionVersion` you read with `accounts.get`; if the session changed since (the user reconnected), it returns `{ saved: false, reason: "session_changed" }` and keeps the newer session. |
| `internal.accounts.recordSync({ accountId, error? })` | After a sync: success stamps `lastSyncedAt`; a `ConnectorError` sets status `expired` (`session_expired`) or `error`. |
| `internal.ingest.upsertPosts({ accountId, posts, page? })` | Upsert `Post[]` by id, including `format`, `expiresAt` and `extracted`; `page: { cursor, caughtUp }` saves the feed cursor. Read it back from `feedCursors` for the next `since`. |
| `internal.ingest.upsertConversations({ accountId, conversations })` | Upsert `Conversation[]` by id. |
| `internal.ingest.upsertMessages({ accountId, messages })` | Upsert `Message[]` by id. |

## Feed rules

`feed.page` merges every platform newest first, hides items whose `expiresAt` has passed (stories), hides posts whose `relevance.score` is below `RELEVANCE_THRESHOLD` (`feed.ts`; unscored posts are shown), and stops at each platform's `seenUntil`. It returns `caughtUp: true` only on the last page when every connected platform's connector reported `caughtUp` on its latest page; then the app shows "You're all caught up" and calls `feed.markCaughtUp({ until })` with the newest `createdAt` it showed. `markCaughtUp` only moves `seenUntil` for platforms whose connector has caught up, so posts from a platform still paging are never skipped. `accounts.disconnect` deletes the platform's cursor and cached content.

## Checks

`npm test` (convex-test), `npx tsc --noEmit -p convex`, `npx convex codegen`.
