import { isLockedXChat, useXChatInbox, useXChatMessages, XCHAT_UNLOCK_HREF, XChatProvider } from '@/src/xchat';
import type { ChatConversation } from '@/src/chat/types';
import { router } from 'expo-router';
import type { ReactNode } from 'react';

import { ChatSourcesProvider, type ChatSources } from './chat-sources';

const X_CHAT: ChatSources = {
  useConversations: (rows) => useXChatInbox(rows as Parameters<typeof useXChatInbox>[0]) as ChatConversation[] | undefined,
  useThread: (conversation) => useXChatMessages(conversation as Parameters<typeof useXChatMessages>[0]),
  openUnavailable: (conversation) => (isLockedXChat(conversation) ? () => router.push(XCHAT_UNLOCK_HREF) : undefined),
};

// Encrypted X Chat (src/xchat) decrypted on this phone, merged into the inbox
// and conversation screens.
export function ChatProviders({ children }: { children: ReactNode }) {
  return (
    <XChatProvider>
      <ChatSourcesProvider sources={X_CHAT}>{children}</ChatSourcesProvider>
    </XChatProvider>
  );
}
