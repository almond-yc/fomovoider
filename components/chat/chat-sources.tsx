import type { ChatConversation, ChatMessage } from '@/src/chat/types';
import { createContext, useContext, type ReactNode } from 'react';

// Messages of one conversation that come from a client-side source instead
// of messages.list, such as X Chat decrypted on the phone.
export type SourceThread = {
  // unlocked: messages can be read and sent; anything else shows the conversation as unavailable.
  status: 'loading' | 'locked' | 'unlocking' | 'unlocked';
  messages: ChatMessage[] | null;
  error: string | null;
  send(text: string): Promise<void>;
};

// Optional client-side chat sources (X Chat, fomovoider#10), mounted once with
// ChatSourcesProvider. Both members are hooks: pass the same functions on
// every render.
export type ChatSources = {
  // Gets conversations.list rows and returns the rows to show; may replace
  // rows (an unlocked chat) and add new ones. The inbox merges and sorts.
  useConversations(rows: ChatConversation[] | undefined): ChatConversation[] | undefined;
  // A thread for conversations this source owns, else null (messages.list is used).
  useThread(conversation: ChatConversation | null | undefined): SourceThread | null;
  // What tapping an unavailable row does (e.g. open an unlock screen), or
  // undefined when this source can't help; unavailable rows aren't openable otherwise.
  openUnavailable?(conversation: ChatConversation): (() => void) | undefined;
};

const NONE: ChatSources = {
  useConversations: (rows) => rows,
  useThread: () => null,
};

const ChatSourcesContext = createContext<ChatSources>(NONE);

export function ChatSourcesProvider({ sources, children }: { sources: ChatSources; children: ReactNode }) {
  return <ChatSourcesContext.Provider value={sources}>{children}</ChatSourcesContext.Provider>;
}

export function useChatSources(): ChatSources {
  return useContext(ChatSourcesContext);
}
