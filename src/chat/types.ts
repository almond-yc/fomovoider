import type { Conversation, Media, Message, Person } from "../connectors/types";

// Inbox rows as the backend returns them (convex/README.md): the contract's
// Conversation and Message with every date in epoch milliseconds. Decrypted
// rows from client-side sources (X Chat) use the same shape.
export type ChatMessage = Omit<Message, "id" | "conversationId" | "sender" | "sentAt" | "raw" | "media"> & {
  id: string;
  conversationId: string;
  sender: ChatPerson;
  sentAt: number;
  media: Media[];
};

export type ChatPerson = Omit<Person, "id"> & { id: string };

export type ChatConversation = Omit<Conversation, "id" | "participants" | "lastMessage" | "updatedAt"> & {
  id: string;
  participants: ChatPerson[];
  lastMessage?: ChatMessage;
  updatedAt: number;
};
