# Fixtures

Built by hand on 2026-11-15 in GramJS's plain-JSON TL shape (`_` = TL name, longs as strings), following the TL schema GramJS 2.26 ships (`telegram/tl/apiTl.js`, layer 198) and core.telegram.org's method pages. None of these were recorded from a live account. Every name, id and access hash is made up.

- `me.json`: `users.getUsers([inputUserSelf])`.
- `dialogs.json`: `messages.getDialogs`. One of each dialog the mapper handles: a 1:1 chat with unread messages (Bob), a supergroup (Book club), a basic group where my message is the last one (Family), a 1:1 chat whose last message is a photo (Carol), a broadcast channel and Saved Messages (both left out), and an archive folder entry (skipped).
- `history-bob.json`, `history-book-club.json`: `messages.getHistory`. They cover my own messages, a photo with a caption, a service message (skipped), a sticker from a `min` user, and a message the supergroup posted as itself.
- `peer-dialogs-bob.json`: `messages.getPeerDialogs` after reading the chat.
- `send-user.json` (`updateShortSentMessage`) and `send-channel.json` (`updates` with `updateNewChannelMessage`): `messages.sendMessage`.
- `login-token.json`, `login-token-success.json`: `auth.exportLoginToken` before and after the QR scan. `token` is base64 in JSON; the fixture transport turns it into bytes.
- `sent-code.json`, `authorization.json`, `password.json`: `auth.sendCode`, `auth.signIn`/`auth.checkPassword`, and `account.getPassword`. The SRP fields are placeholders: in mock mode `passwordCheck` carries the plain password instead of computing SRP.

Dates are around 2025-11-15T20:00:00Z. Replace these with scrubbed real recordings once a throwaway account is connected.
