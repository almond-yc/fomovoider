import type { Doc } from "../../convex/_generated/dataModel";
import type { Conversation, Message } from "../connectors/types";

// The shapes Convex's public queries return (conversations.list,
// messages.list): the contract Conversation and Message with dates as epoch
// milliseconds (convex/README.md). The X Chat hooks take and return these, so
// decrypted X Chat rows merge with every other platform's rows as they are.
export type InboxConversation = Omit<Doc<"conversations">, "_id" | "_creationTime" | "userId">;
export type InboxMessage = NonNullable<InboxConversation["lastMessage"]>;

export function isLockedXChat(conversation: Pick<Conversation, "platform" | "unavailable"> | undefined | null): boolean {
  return conversation?.platform === "x" && conversation.unavailable?.reason === "locked";
}

export function toInboxMessage({ raw: _raw, sentAt, ...rest }: Message): InboxMessage {
  return { ...rest, sentAt: Date.parse(sentAt) };
}

// A locked row with its newest decrypted message (messages newest first).
export function unlockedInboxRow<C extends InboxConversation>(conversation: C, messages: InboxMessage[]): C {
  const { unavailable: _locked, ...rest } = conversation;
  const lastMessage = messages[0];
  if (!lastMessage) return rest as C;
  return { ...rest, lastMessage, updatedAt: Math.max(rest.updatedAt, lastMessage.sentAt) } as C;
}
