# Fomovoider

**All the good parts of social media. None of the slop.**

## The problem

Social apps are built to keep you scrolling. You open them for posts from people you follow and for your messages, and you leave an hour later having seen mostly things you never asked for.

## The idea

Fomovoider is a mobile app meant to be the only interface you use for social media. Uninstall Twitter/X, Instagram and the rest, keep Fomovoider, and you still get what matters without the distraction.

It has exactly two tabs:

- **Feed**: posts from Twitter/X, Instagram and other platforms in one finite feed. It ends. No infinite scroll.
- **Chats**: your DMs from all those platforms, gathered in one inbox.

## Principles

- **Finite by design.** The feed has an end, and reaching it means you're done.
- **One app.** One place for every platform, instead of many apps competing for your attention.
- **Simple.** Two tabs. Nothing else.

## Status

Fomovoider covers two platforms: X and Instagram.

**On main today**

- **Accounts**: sign up and sign in with email and password, then answer "What's slop for you?" once (editable from the Feed header). Sign in with Apple and Google is written but commented out until OAuth credentials exist.
- **Connect**: until one platform is connected, the app shows a Connect screen instead of the tabs, with a row for X (X's own sign-in) and one for Instagram (pairing a device with a one-time code).
- **X Chat passcode**: right after X is connected on the Connect screen, the app asks once for the X Chat passcode, after the consent copy, so the server can unlock and sync encrypted X chats. A wrong passcode shows how many tries X has left; Skip for now leaves encrypted chats locked. The passcode is sent to `x.chatNode.setPasscode` and never stored on the phone.
- **Settings** (gear in the native header): each platform's handle, status and last sync, Sync now, Disconnect (which deletes that platform's data from Fomovoider), and Sign out. Under Twitter, the X Chat passcode line shows Not set, Active or Needs re-entry (with X's reason), with Set or Change and Remove.
- **Chats tab**: the inbox and a conversation screen, with X conversations (Instagram DMs aren't synced yet), sending X DMs and replies, and pending or failed delivery shown on each message. Encrypted X Chat conversations are decrypted on the server once the user has entered their X Chat passcode, and show as locked until then.
- **Feed tab**: the signed-in user's finite feed from Convex (`feed.page`), newest first across platforms, with skeletons while it loads. It ends at "You're all caught up", which also marks where the next session starts. Pull to refresh re-queries and asks each connector with a sync mutation to sync. Posts are marked seen as they scroll into view and opened when you tap the platform icon; long-press a post to save or hide it. Stories and tagged places show quietly on the card. A connected account in trouble (signed out, X credits used up) shows as a one-line notice above the feed. `/feed-preview` renders the same post component with sample data for design work.
- **Backend** on Convex: Convex Auth with email and password, connected accounts, the shared `posts`, `postStates`, `conversations` and `messages` tables, `feed.page` with the finite cutoff, media copies in Convex file storage, a daily retention cron, and the registration points connectors use for their own tables and crons. See [convex/README.md](convex/README.md).
- **X connector** (`src/connectors/x/`, `convex/x/`): official X API v2 with OAuth 2.0 PKCE, the code exchanged on the server, a 6-hourly sync of the home feed, mentions and DMs, and DM sends. The shared dev deployment holds real X posts and DMs from a team account.
- **Instagram connector** (`convex/instagram/`, `hosts/instagram/`): read-only. A host agent on a Mac drives the Instagram app on the user's paired iPhone through WebDriverAgent and sends posts and stories to Convex on runs that Convex schedules.

**In open pull requests**

- #27: drop the `steps` login kind from the connector contract.
- #28: let connectors pass `Media.storageId` for post media.

**Planned**

App-side filtering of the feed. Connectors extract and store; deciding what is slop is the app's job.

## Architecture

```mermaid
flowchart LR
  P["X and Instagram"] --> C["Connectors<br/>src/connectors/{platform}"]
  C -->|"sync actions and crons in convex/{platform}"| T[("Shared Convex tables<br/>posts, conversations, messages")]
  T -->|"feed.page, conversations.list, messages.list"| A["Expo app<br/>Feed and Chats tabs"]
```

- **App**: Expo (React Native, TypeScript) with Expo Router and react-native-reusables on NativeWind. `app/_layout.tsx` picks the screen from the `users.viewer` query: sign up or sign in, Connect, or the tabs under the native stack header. Every Convex query it subscribes to is scoped to the signed-in user, and `lib/connectors.ts` lists the platforms it can connect and how each signs in.
- **Backend**: [Convex](https://convex.dev) holds accounts, sessions and normalized content, and schedules every sync from crons.
- **Connectors** turn one platform into the shared types in [src/connectors/types.ts](src/connectors/types.ts) (`Post`, `Conversation`, `Message`, `Person`), with namespaced ids like `x:123` and typed errors, and write only through the shared ingest functions. X runs inside Convex actions; Instagram's host agent reports to Convex mutations from the Mac. Each connector's own code and tables live in `convex/<platform>/`, registered with one schema spread and one cron call.
- **Finite feed**: `feed.page` merges every platform newest first and stops where the user last caught up. Connectors return what is new since a cursor and report when they are caught up; nothing pages infinitely. The Feed tab pages through `feed.page` with `usePaginatedQuery`, reads `feed.connectorsCaughtUp` to know when the last page is the end, and calls `feed.markCaughtUp` when the user reaches it. What the user does with each post (seen, opened, hidden, saved) goes to `postStates`.
- **Filtering happens in the app.** Connectors extract and store, and never rank or filter for quality.

## Development

The app is an [Expo](https://expo.dev) (SDK 58) React Native project written in TypeScript. You need Node.js 22.13+ or 24.3+.

```bash
npm install        # install dependencies
npm start          # start the Expo dev server, then scan the QR code with Expo Go
npm run android    # or open on an Android emulator/device
npm run ios        # or open on an iOS simulator (macOS only)
npx tsc --noEmit   # typecheck
npm test           # unit and Convex backend tests (vitest, convex-test)
```

Add packages with `npx expo install <package>` so versions stay compatible with the Expo SDK.

### Convex

The app reads its backend URL from `EXPO_PUBLIC_CONVEX_URL`; copy `.env.example` to `.env.local` to point it at the shared dev deployment.

```bash
npx convex dev --local            # run unmerged backend code on a local backend
npx convex codegen                # regenerate convex/_generated
npx tsc --noEmit -p convex        # typecheck the backend
```

The shared dev deployment only runs main. Deploy it (`npx convex deploy`, authenticated by `CONVEX_DEPLOY_KEY`) only from main, or from a branch just rebased onto main whose PR is about to merge, because a deploy replaces every other team's functions, crons and indexes. Never commit or print `CONVEX_DEPLOY_KEY`. Connector env vars (such as `X_CLIENT_ID`) are set on the Convex deployment; see each connector's README.
