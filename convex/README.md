# Convex backend

Dev deployment: `groovy-bobcat-759`. The app reads its URL from `EXPO_PUBLIC_CONVEX_URL` (see `.env.example`).

## Shared (App crew)

Everything in `convex/` except `convex/<platform>/`:

- `schema.ts`: `sharedTables`, the Convex Auth tables (`users`, ...), `connectedAccounts` (one per user and platform, holding the connector `Session`), `feedCursors` (per user and platform: connector cursor, `caughtUp`, and `seenUntil`, where the feed ends), `posts`, `postStates`, `conversations`, `messages`. Rows mirror the contract's (`src/connectors/types.ts`) `Post`, `Conversation`, `Message` and `Person` types plus the owning `userId`; `raw` is never stored.
- **Dates are epoch milliseconds.** Connectors pass the contract's ISO strings; ingest converts every date (`createdAt`, `expiresAt`, `extracted.event.startsAt`, `sentAt`, `updatedAt`) to epoch ms, and every public query returns epoch ms. Posts also carry `fetchedAt` (first ingest) and `updatedAt` (last upsert). `feed.markCaughtUp({ until })` takes epoch ms too.
- **Posts**: `sponsored` and `suggested` (contract v7.3) record the platform's own ad and suggestion markers; connectors never drop those posts, the app decides. `title` holds real titles only (empty titles and titles equal to the author's name or handle are dropped at ingest). `text` is cut to 10,000 characters. Engagement counts are never stored; the validators reject them.
- **Media**: `media[].width`, `height` and `blurhash` are kept when a connector sends them. For platforms in `PERSIST_MEDIA` (`lib/media.ts`; Instagram on, X off), ingest schedules `internal.media.persist`, which copies each media file and the author's avatar into Convex file storage (`media[].storageId`, `author.avatarStorageId`). A connector that already uploaded a file to Convex storage passes its `media[].storageId` on a post (messages do not take one); ingest checks the file exists, keeps it, and copies nothing. Use one file per post, since retention deletes it with the post. `feed.page` returns the stored copy's URL in `url`/`avatarUrl` and falls back to the platform URL.
- `postStates.ts`: per user and post, `markSeen` (or `markSeenMany` for up to 100 posts in one call), `markOpened`, `setHidden`, `setSaved`, checked against the post's owner. `feed.page` leaves hidden posts out and returns each post's `savedAt`.
- `retention.ts`: the daily `app:retention` cron (registered with `registerAppCrons` in `crons.ts`) deletes posts past `expiresAt` and posts older than 30 days that the user hasn't saved, with their stored files and states.
- `lib/validators.ts`: validators for the contract types. Import them instead of redefining.
- `auth.ts`: Convex Auth with the Password provider (email and password, no verification yet) and anonymous sign-in for dev deployments only; Google and Apple are commented out until OAuth credentials exist (see "Sign-in").
- Public functions for the app, all scoped to the signed-in user: `feed.page`, `feed.connectorsCaughtUp`, `feed.markCaughtUp`, `postStates.*`, `conversations.list`, `messages.list`, `users.viewer` (the signed-in user's email, `slopDescription`, `onboardedAt`, `connectStepPending` and connected accounts, or null when signed out; the app's gate and Settings read it), `users.setSlop` (saves the onboarding answer, trimmed and at most 1,000 characters; the first save stamps `onboardedAt` and sets `connectStepPending`), `users.finishConnectStep` (Continue on the Connect screen during onboarding; clears `connectStepPending` once an account is active), `accounts.list` (never returns sessions), `accounts.connect`, `accounts.disconnect`.

## Sign-in

`auth.ts` signs users in with email and password through Convex Auth's Password provider (no email service, no verification yet). The app's sign-up and sign-in screens call `signIn("password", { email, password, flow })`.

Google and Apple are written but **commented out** until OAuth credentials exist: the providers in `auth.ts` and `OAUTH_ENABLED` in `components/oauth-buttons.tsx`. With them on, the app calls `signIn("google" | "apple", { redirectTo })`: on web the browser follows the redirect and returns to `SITE_URL` with a `code` the provider handles; on iOS and Android the app opens the provider in `expo-web-browser`'s auth session, gets back `fomovoider://?code=...` (`exp://...` in Expo Go), and finishes with `signIn(provider, { code })`. The `redirect` callback accepts only `SITE_URL` (and paths under it) and `fomovoider://`, plus `exp://` (Expo Go) on deployments that set `AUTH_ALLOW_EXPO_GO=true`.

Convex environment variables (`npx convex env set NAME value`, per deployment):

| Variable | Value |
| --- | --- |
| `JWT_PRIVATE_KEY`, `JWKS` | Convex Auth signing keys (already set on dev; `npx @convex-dev/auth` generates them). |
| `SITE_URL` | Web app origin, e.g. `http://localhost:8081` in dev; OAuth returns to it. |
| `AUTH_ANONYMOUS_ENABLED` | `true` on dev deployments only. Anything else refuses `signIn("anonymous")`. |
| `AUTH_ALLOW_EXPO_GO` | `true` on dev deployments only, to accept OAuth redirects to `exp://` (Expo Go). `exp://` can point at any host, so never set it on prod. |

For local testing, set `AUTH_ANONYMOUS_ENABLED=true` on the deployment and `EXPO_PUBLIC_DEV_ANONYMOUS_SIGN_IN=true` in `.env.local`; the sign-in screens then offer "Continue anonymously (dev)".

### Re-enabling Google and Apple

Where `<site>` is the deployment's HTTP Actions URL (`https://groovy-bobcat-759.convex.site` on dev):

1. **Google Cloud**: create an OAuth 2.0 client of type "Web application" with authorized redirect URI `<site>/api/auth/callback/google` (and the OAuth consent screen). Set `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`.
2. **Apple Developer**: an App ID with Sign in with Apple enabled; a Services ID with domain `<site>` (host only) and return URL `<site>/api/auth/callback/apple`; a Sign in with Apple key (.p8) with its Key ID and your Team ID. Set `AUTH_APPLE_ID` to the Services ID identifier and `AUTH_APPLE_SECRET` to the client-secret JWT signed with the key. Apple caps that JWT at 6 months, so regenerate it before it expires. Apple refuses `localhost`, so it only works through the public `.convex.site` URL.
3. Check `SITE_URL` is the web app origin, and that `AUTH_ALLOW_EXPO_GO` is unset everywhere but dev.
4. Uncomment the Google and Apple imports and providers in `convex/auth.ts`, and set `OAUTH_ENABLED = true` in `components/oauth-buttons.tsx`.

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

`feed.page` merges every platform newest first, hides items whose `expiresAt` has passed (stories), hides posts whose `relevance.score` is below `RELEVANCE_THRESHOLD` (`feed.ts`; unscored posts are shown), and stops at each platform's `seenUntil`. It returns `caughtUp: true` only on the last page when every connected platform's connector reported `caughtUp` on its latest page; then the app shows "You're all caught up" and calls `feed.markCaughtUp({ until })` with the newest `createdAt` it showed. `usePaginatedQuery` keeps only each page's items, so the app reads `feed.connectorsCaughtUp` instead: the feed is caught up when the hook reports `Exhausted` and that query is true. `markCaughtUp` only moves `seenUntil` for platforms whose connector has caught up, so posts from a platform still paging are never skipped. `accounts.disconnect` deletes the platform's cursor and cached content.

## Morning Brief (`convex/brief/`)

Every morning at 6:30 in each onboarded user's time zone (`users.timeZone`, set by the app through `brief.setTimeZone`, default America/Los_Angeles) the hourly `brief:dispatch` cron starts one `@convex-dev/workflow` run per user and local date (`brief/workflow.ts`):

1. **Collect**: queues an Instagram run (`instagram/devices:runNowForUser`) and runs X's `syncAccount`, then polls the Instagram run for up to 20 minutes. A missing, paused, offline or slow source is recorded in `brief_runs.skipped`; it never fails the run.
2. **Select**: posts created since the previous brief's cutoff (24 h for the first), not expired, not hidden, with no verdict, newest first, at most 200. Sponsored posts (`post.sponsored` or `instagram_postFacts.sponsored`) get an `ad` verdict without a model call.
3. **Judge**: each post goes through the `briefJudgePool` workpool (5 at a time, retried with backoff) to `brief/judge:judgePost`, a LangChain agent on `gpt-6.1-sol` that sees the text, the facts, and up to 8 images (downscaled images, 3 GIF frames, a video's poster plus 4 keyframes via ffmpeg-static, quoted media last), and can call `inspect_video` for more frames. One verdict per post (`brief_verdicts`).
4. **Save**: `brief_items` ranked by priority, then recency, with the media indices the agent kept.

The app reads `brief.today`, `brief.byDate` and `brief.dates`. Retention deletes a post's verdict and brief item with the post (`lib/posts.ts`). Needs `OPENAI_API_KEY` on the deployment; without it every model call fails and the run ends as `failed`. To run one now on a local backend: `npx convex run brief/crons:startNow '{"userId": "..."}'`.

## Checks

`npm test` (convex-test), `npx tsc --noEmit -p convex`, `npx convex codegen`.
