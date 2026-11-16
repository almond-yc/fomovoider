# Instagram DMs via the hidden web view

A plug-in to `InstagramWebViewHost` (`../webview`). It reads the user's Primary inbox on instagram.com in the same hidden web view and session as the feed, puts it in the shared `conversations`/`messages` tables through ingest, and sends messages and seen receipts by driving the page the way a person does. iOS only; realtime only while the app is open.

`~mermaid
flowchart LR
  subgraph Phone["Fomovoider app (iOS)"]
    H["InstagramWebViewHost<br/>/direct/inbox/"] -- "inbox + thread responses, lightspeed deltas" --> C["sync.ts capture"]
    O["sync.ts deliver"] -- "open chat, type, tap Send, back" --> H
  end
  C -- "dms:submit" --> D["convex/instagram/dms.ts"]
  D --> I["ingest.upsertConversations / upsertMessages"]
  S["send.message / send.markRead<br/>(inbox registry)"] --> Q[("instagram_outbox")]
  Q -- "dms:outbox, claim" --> O
  O -- "dms:complete" --> D
`~

## Mounting

`~tsx
<InstagramWebViewHost {...DM_HOST_PROPS}>
  <InstagramDms />
  {children}
</InstagramWebViewHost>
`~

`DM_HOST_PROPS` adds the DM GraphQL operations to the capture list and injects `WEBSOCKET_HOOK_JS` before the page's scripts (the host's `scripts` prop).

## Read

- **Inbox.** On app open (at most every 2 minutes, `dms:startSync`) the web view loads `/direct/inbox/`. The page's own `PolarisDirectInboxMobileQuery` gives 15 Primary threads with members, the id in each chat's URL (`thread_key`), read receipts and the last 5 messages. Requests and General are skipped. The inbox sets each conversation's `unreadCount`.
- **History.** The page prefetches `IGDThreadDetailQuery` (20 messages) for about 20 threads by itself, without marking anything seen. Those messages are stored too; messages of threads the inbox never showed are dropped.
- **Realtime.** The hook listens on `wss://gateway.instagram.com/ws/lightspeed` and forwards Iris `slide_delta_processor` payloads. New messages move the conversation preview and count as unread, the viewer's own read receipts (read in the Instagram app) clear unread, reactions are ignored. A delta type the parser doesn't know, or a gap in `uq_seq_id`, reloads the inbox (same 2-minute spacing).
- Ids: conversations `instagram:<thread_fbid>`, messages `instagram:<message_id>`, people `instagram:<username>` like posts. The viewer's own messages use the account's `me`.
- Media in messages (photos, videos, GIFs, stickers) is kept as Instagram CDN URLs, which expire after a few days. Disappearing photos and videos show as text.

## Write

- `internal.instagram.send.message({ accountId, conversationId, text })` stores the message as `delivery: pending` (id `instagram:local:<outbox id>`), moves the preview, and queues it. Text is trimmed, at most 1,000 characters, and only for chats the inbox has shown.
- `internal.instagram.send.markRead({ accountId, conversationId })` queues one seen receipt per chat.
- The phone watches `dms:outbox`, claims one item at a time and runs it in the host queue: it taps the chat's row in the inbox (or loads `/direct/t/<thread_key>/`), which is what makes Instagram mark it seen. For a send it checks the composer is empty, types at 90-260 ms a character through the editor's input path, checks the typed text, taps Send once and reads the page's own `IGDirectTextSendMutation` response. Then it goes back to the inbox so later messages aren't marked seen.
- `dms:complete` flips the row to `sent` with Instagram's message id and time, or to `failed` with a readable error. A claim not completed in 3 minutes fails as unconfirmed. Nothing retries a send. When the captured copy of a sent message arrives it replaces the row and the delivery field goes away (delivered).
- Never a crafted request: only the page's own composer and Send button.

## Safety

The kill switch and a tripwire pause stop inbox loads and empty the outbox (queued sends fail with a reason). A challenge or login page during DM work pauses the device for 72 hours, like a feed refresh.

## Tests

`npx vitest run src/instagram/dms convex/instagram/dms.test.ts`. Fixtures are redacted captures from the FOMO-23 spike; the realtime new-message delta in `parse.test.ts` is synthesized because none arrived during the spike.

## Known limits

- History beyond the prefetched 20 messages per chat isn't loaded (it would need scrolling up inside an open chat).
- Others' seen receipts (the "Seen" under your message) are parsed but not stored; the shared Message has no field for them.
- Background refresh isn't wired (`syncInbox("background")` exists; the host has no BGAppRefreshTask yet).
- Sends wait behind a running feed refresh in the host queue (up to its 4-minute budget).
