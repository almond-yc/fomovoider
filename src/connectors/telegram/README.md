# Telegram connector

Implements the app's `Connector` contract (`src/connectors/types.ts`) for Telegram **chats** (capabilities `chats`, `sendMessage`; no feed, media sending or replies). It uses Telegram's official user API (MTProto) through [GramJS](https://github.com/gram-js/gramjs), with an `api_id`/`api_hash` from my.telegram.org. Telegram allows third-party clients on its user API, so unlike WhatsApp or Messenger this isn't an unofficial client. Merging, read state in the UI, session storage and the connect screens belong to the app.

The core (`connector.ts`, `auth.ts`, `mappers.ts`, `ids.ts`, `errors.ts`, `sessions.ts`, `transport.ts`, `mock.ts`) has no GramJS, Node-only, Expo or React Native imports. It speaks **plain-JSON TL** through an injected `TelegramTransport`: every object carries its TL name in `_` (`{ _: "messages.getHistory", peer: { _: "inputPeerUser", ... } }`), longs are decimal strings and bytes are `Uint8Array`s. `gramjs.ts` is the only file that imports GramJS. It converts that JSON to GramJS objects and back, and it maps GramJS errors to `TelegramRpcError` with Telegram's raw message (`FLOOD_WAIT_30`, `AUTH_KEY_UNREGISTERED`). It needs Node (MTProto over TCP), so it runs in Convex `"use node"` actions and scripts, never in the app.

## Why GramJS and not TDLib

TDLib is Telegram's own library and the more complete client, but it is a native binary that keeps its state in a local database directory and expects a long-lived process. Convex actions are short-lived and have no persistent disk. GramJS is pure JavaScript, and its whole session is one string (the auth key plus the data center), so each action can reconnect from the stored string. If the bridge host ends up holding persistent connections, TDLib becomes an option again; the core wouldn't change, only the transport.

## Sessions: the contract's `device` kind, no new Session kind

A Telegram session string is a full login to the account, so it never goes into the contract's `Session`. The account's `Session` is `{ platform: "telegram", kind: "device", deviceId }`, and `deviceId` names a row in the connector's own `telegram_sessions` table, which holds the string AES-GCM encrypted (see `convex/telegram/README.md`). That's what the `device` kind is for, so the Session union is unchanged; only its comment now says "a paired phone, or a linked session it holds". The connector resolves `deviceId` through an injected `SessionStore`.

Telegram also needs an **access hash** besides the id to address a user or supergroup. The connector learns hashes from every result and keeps them in an injected `PeerStore` (`telegram_peers` in Convex). For a peer it doesn't know yet, it looks through the newest 500 chats before giving up with "Telegram doesn't know this chat." Hashes from `min` users (partial users seen only inside groups) are never stored, because they only work in the context they came from.

## Login: a proposed new `Login` kind, `steps`

QR login and phone code login both take several rounds (show the QR or ask for the code, then maybe ask for the 2FA password), and they must run server-side, because the `api_hash` and the MTProto connection live there. None of the existing `Login` kinds fit, since each is a single call. This PR adds the smallest kind that does (in `types.ts`):

```ts
type LoginStep =
  | { kind: "qr"; url: string; expiresAt: ISODate }                // show url as a QR code; call next() to poll
  | { kind: "code"; phone: string; via?: string; length?: number } // ask for the code (via app, sms, call, ...)
  | { kind: "password"; hint?: string }                            // ask for the 2FA password
  | { kind: "done"; session: Session };

| { kind: "steps"; methods: ("qr" | "phone")[];
    start(input: { method: "qr" } | { method: "phone"; phone: string }): Promise<LoginStep>;
    next(answer?: string): Promise<LoginStep>;
    cancel(): Promise<void> }
```

The app shows whatever the step asks for and passes the answer to `next()` until it gets `done`. For a QR step it calls `next()` with no answer every few seconds, re-rendering the QR when the URL changes. A wrong code or password rejects with a `platform` error and keeps the step, so the app can ask again. In the app, the methods map one-to-one onto the Convex actions `telegram/login:start`, `telegram/login:next` and `telegram/login:cancel`. Those keep the half-finished login encrypted between rounds and finish by checking that the new session row belongs to the signed-in user and calling `internal.accounts.connectDevice` themselves, so on `done` the account is already connected:

```ts
const login: Login = {
  kind: "steps",
  methods: ["qr", "phone"],
  start: (input) => convex.action(api.telegram.login.start, input),
  next: (answer) => convex.action(api.telegram.login.next, { answer }),
  cancel: () => convex.action(api.telegram.login.cancel, {}),
};
```

`TelegramAuth` (`auth.ts`) does the work round by round: `auth.exportLoginToken` (a `tg://login?token=…` URL, valid for about 30 seconds; after the scan it follows `auth.loginTokenMigrateTo` to the account's data center), or `auth.sendCode` and `auth.signIn`, and then `account.getPassword` and `auth.checkPassword` (SRP, computed by GramJS) when Telegram answers `SESSION_PASSWORD_NEEDED`. Each round opens a client on the pending session string, so rounds can run in separate actions. `createTelegramLogin(auth, save)` builds the same `steps` Login in one process (the smoke script, mock mode).

The person scans the QR code in Telegram → Settings → Devices → Link Desktop Device. Afterwards the session appears in their device list as "Fomovoider".

## What each call does

| Contract call | Telegram method | Notes |
|---|---|---|
| `account` | `users.getUsers([inputUserSelf])` | Validates the session. |
| `conversations` | `messages.getDialogs` | Newest first, up to 100 per page; cursor `d1\|<date>\|<id>\|<peer>`. 1:1 chats (bots included), basic groups and supergroups. Broadcast channels (feeds, not chats), Saved Messages and the archive folder are left out. |
| `messages` | `messages.getHistory` | Newest first, up to 100; cursor `m1\|<oldest id>`. Extra option `after` (a message id) returns only newer messages, for incremental syncs. Service messages (joins, pins, calls) are skipped. |
| `send` | `messages.sendMessage` | Text only (`sendMedia: false`). Runs once and is never retried. |
| `markRead` | `messages.readHistory` / `channels.readHistory` | Reads up to the newest message, as opening the chat in Telegram does. |
| `chats` (extra) | `messages.getDialogs` | `conversations` plus each chat's newest Telegram message number, service messages included, so a sync can tell when history moved. `limit` counts dialogs before filtering, so a page can hold no chats and still have more after it. |
| `conversation` (extra) | `messages.getPeerDialogs` | One conversation as the chat list shows it now; used after `send` and `markRead`. |
| `feed` | — | `unsupported`. |

Call `close()` when done: the connector keeps one MTProto connection per session for its lifetime.

## Normalization

- Ids: conversations are `telegram:user:<id>` (1:1), `telegram:chat:<id>` (basic group) or `telegram:channel:<id>` (supergroup). Messages are `telegram:<peer>:<message id>`, because supergroup message numbers are only unique per group. People are `telegram:user:<id>`.
- `Person.handle` is the username (or the first active one of several), or `""` when the person has none. `displayName` is the first and last name, and `profileUrl` is `https://t.me/<username>`. Phone numbers are never read. `avatarUrl` is unset, because Telegram photos are downloaded over MTProto and there's no URL.
- A supergroup message posted as the group or a channel (anonymous admins) has that chat as its `sender`.
- `participants` holds the other person in a 1:1 chat. For groups it's empty and `title` is set: listing members costs a call per group.
- `lastMessage` is unset when the chat's newest message is a service message.
- `unreadCount` is Telegram's own. `updatedAt` is the last message's date.
- **Media isn't downloaded** (`media: []`). The text names what was attached, before any caption: `[Photo] Look at this view`, `[Sticker 👍]`, `[Voice message]`, `[File: menu.pdf]`, `[Poll: Where?]`. Link previews add nothing, since the link is already in the text.
- `chatForbidden`/`channelForbidden` dialogs (removed from the group) come back with `unavailable: { reason: "unsupported" }`.
- `raw` keeps the TL message for debugging only.

## Secret chats

Secret chats are end-to-end encrypted and bound to the device that started them. Their keys never leave that phone, and `messages.getDialogs` doesn't list them. So they are **omitted**, not surfaced as `unavailable`: the connector can't even tell they exist. They stay readable only in the Telegram app. Telegram's normal chats ("cloud chats") are encrypted client-to-server, not end to end, which is why the official API can read them.

## Errors

Every failure is a `ConnectorFailure`:

- `session_expired`: `AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED` or another 401 (the person ended the session in Settings → Devices, or logged out), a deactivated account, a missing stored session, or a non-`device` session.
- `rate_limited`: `FLOOD_WAIT_n` (`retryAt` = now + n seconds), `SLOWMODE_WAIT_n`, or another 420. GramJS sleeps through waits of up to 5 seconds itself (`floodSleepThreshold`).
- `unsupported`: `feed`, or media in `send`.
- `network`: the request never reached Telegram, or a 5xx.
- `platform`: anything else Telegram refused, with a readable message for the common cases: a wrong code or password, an expired code or QR, a blocked user, no right to write in the group, and so on.

## Mock mode and fixtures

`createMockTelegramConnector()` needs no credentials. It serves `fixtures/` through `createFixtureTransport()`, already holds `MOCK_TELEGRAM_SESSION`, and its `steps` login works: a QR code is accepted on the first poll; the phone code `12345` signs in, and `22222` asks for the 2FA password `hunter2`. Wire it to `EXPO_PUBLIC_TELEGRAM_MOCK=1` in the app layer, and to `TELEGRAM_FIXTURES=1` on a local Convex backend.

## Tests

`npm test` runs the connector, login and mapping tests over the recording fixture transport (`__tests__/helpers.ts`). Tests can't reach Telegram: the core only talks to the injected transport, the Convex tests mock `gramjs.ts`, and `__tests__/gramjs.test.ts` only checks the GramJS conversions offline (it never connects). `npx tsc --noEmit` typechecks.

## Live smoke test (manual, throwaway account)

`scripts/telegram-live-smoke.mts` logs in with a phone code (and 2FA password), or with `TELEGRAM_LOGIN=qr`. It prints the account and the newest 5 chats normalized, then logs the session out again. The session string stays in memory. It refuses to run without `TELEGRAM_LIVE=1`:

```sh
TELEGRAM_LIVE=1 TELEGRAM_API_ID=... TELEGRAM_API_HASH=... npm run telegram:smoke
```

## Setup for a live account

1. Sign in at my.telegram.org with the phone number of the Telegram account that will own the app, then open **API development tools** and create an application. Platform: Other.
2. Put the `api_id` and `api_hash` in `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` on the Convex deployment (see `convex/telegram/README.md`). Both stay server-side.

## Known gaps

- Unverified live: the connector was tested against fixtures built from the TL schema GramJS ships (layer 198), not against recordings. GramJS itself was checked inside a local Convex Node action: it completed the MTProto handshake with Telegram, and Telegram answered `API_ID_INVALID` to a dummy `api_id`. The first smoke test with real credentials settles the rest.
- Media: not downloaded or sent (see above). Downloading photos into Convex file storage in the sync is the natural next step.
- Edits and deletions of messages that were already synced aren't picked up by polling. The sync only fetches messages newer than the stored last one.
- The archive folder, forum topics (a forum supergroup is one conversation), and group member lists aren't covered.
