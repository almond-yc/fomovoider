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

Early. Nothing is built yet.

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
