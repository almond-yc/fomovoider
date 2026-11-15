# X Chat on the phone

Encrypted X Chat conversations, decrypted on this phone and returned in the same shape as `api.conversations.list` and `api.messages.list` rows: the contract `Conversation` and `Message` (`src/connectors/types.ts`) with dates as epoch milliseconds, per `convex/README.md`. The types are `InboxConversation` and `InboxMessage`. Decrypted X Chat rows therefore merge with every other platform's rows as they are. Convex only ever holds ciphertext; see `convex/x/README.md`, "X Chat".

## Using it from the Chats tab

1. Mount `<XChatProvider>` once, inside `ConvexClientProvider`, above both the Chats tab and `/x-chat/unlock`. The root layout is the natural place. Nesting is safe: an inner provider reuses the outer one. Without a provider the hooks below still work and leave X Chat rows locked.
2. Pass the unified conversation list through `useXChatInbox`:

```tsx
import { isLockedXChat, useXChatInbox, XCHAT_UNLOCK_HREF } from "@/src/xchat";

const merged = useXChatInbox(conversations); // conversations.list rows in, same rows out
// Locked X Chat rows keep unavailable: { reason: "locked" } and no lastMessage.
// Once the user unlocks, the newest 10 get their lastMessage decrypted and
// unavailable removed. Re-sort by updatedAt if you sort client-side.
const onPress = (c) => (isLockedXChat(c) ? router.push(XCHAT_UNLOCK_HREF) : openThread(c));
```

3. In a conversation screen, use `useXChatMessages(conversation)`. It returns `null` for anything that isn't an X Chat conversation, so you can fall back to `api.messages.list`. For X Chat it returns:

| Field | |
| --- | --- |
| `status` | `"loading" \| "locked" \| "unlocking" \| "unlocked"` |
| `messages` | `InboxMessage[] \| null`, newest first; null until decrypted |
| `error` | `string \| null` |
| `send(text)` | Encrypts on the phone, then sends through Convex. Throws while locked. |
| `refresh()` | Fetches up to 10 more events from X inside the daily budget: newer ones first, then older history, resuming where the last fetch stopped. |

4. `useOptionalXChat()` gives the lock state (`status`, `error`, `lock()`) for a lock/unlock control, or `null` without a provider.

Plaintext lives only in React state and the engine's memory. Don't persist decrypted `Message` objects (no Convex writes, no AsyncStorage, no logs).

## Temporary screens

`app/x-chat/index.tsx` and `app/x-chat/[id].tsx` are a stopgap inbox and conversation view for testing until the real Chats tab consumes the hooks above; delete them then. `unlock.tsx` and `settings.tsx` are meant to stay.
