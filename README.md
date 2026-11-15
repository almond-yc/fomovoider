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

Early. What works today:

- **Accounts**: sign up and sign in with email and password. Email verification and Sign in with Apple come later.
- **Connect**: until one platform is connected, the app shows a Connect screen instead of the tabs. Twitter/X connects through X's own sign-in. Instagram pairs a device with a one-time code; this needs the Instagram connector's backend, which isn't on main yet.
- **Settings** (gear in the top bar): each platform's handle, status and last sync, Sync now, Disconnect (which deletes that platform's data from Fomovoider), and Sign out.
- **Feed and Chats**: the tabs exist, but they don't show synced data yet.

## Architecture

- **App**: Expo Router. `app/_layout.tsx` decides what you see from the `users.viewer` query: signed out (sign up or sign in), signed in with nothing connected (Connect), or the tabs. The top bar is the native stack header. UI is react-native-reusables on NativeWind.
- **Connectors**: each platform is a connector behind one contract, `src/connectors/types.ts`. `lib/connectors.ts` lists the ones the app can connect and how each signs in.
- **Backend**: Convex (`convex/`; see `convex/README.md`). It handles auth, connected accounts, the shared post and message tables, and each connector's sync under `convex/<platform>/`.

## Development

The app is an [Expo](https://expo.dev) (SDK 58) React Native project written in TypeScript. You need Node.js 22.13+ or 24.3+.

```bash
npm install        # install dependencies
npm start          # start the Expo dev server, then scan the QR code with Expo Go
npm run android    # or open on an Android emulator/device
npm run ios        # or open on an iOS simulator (macOS only)
npx tsc --noEmit   # typecheck
```

Add packages with `npx expo install <package>` so versions stay compatible with the Expo SDK.
