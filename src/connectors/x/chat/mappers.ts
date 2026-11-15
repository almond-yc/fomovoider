import type { Conversation, Id, Message, Person } from "../../types";
import type { ChatEventRow } from "./client";
import { eventSortKey } from "./ids";

// The part of a Chat XDK decrypted Event the mappers read. The device sends
// these from its decrypt step; nothing here imports the XDK.
export interface DecryptedChatEvent {
  type: string;
  senderId?: string | null;
  createdAtMsec?: number | null;
  content?: { contentType?: string; text?: string; updatedText?: string; targetMessageSequenceId?: string; attachments?: unknown[] } | null;
  attachments?: unknown[] | null;
}

// One stored row after decryption: the event, or why it couldn't be read.
export type DecryptOutcome = { event: DecryptedChatEvent } | { error: string };

export const UNDECRYPTABLE_TEXT = "This message couldn't be decrypted.";
export const ATTACHMENT_TEXT = "[Attachment]";

// Decrypted X Chat events of one conversation as contract Messages, newest
// first. Key changes, receipts, reactions and group changes are not messages;
// edits replace the text of the message they target. An encrypted row that
// failed to decrypt stays visible as a placeholder, so the timeline has no
// silent gaps.
export function chatMessages(
  rows: ChatEventRow[],
  outcomes: DecryptOutcome[],
  ctx: { conversationId: Id; meId: string; people: Map<string, Person> },
): Message[] {
  const messages = new Map<string, Message>();
  const edits: { order: string; target: string; text: string }[] = [];
  rows.forEach((row, i) => {
    const outcome = outcomes[i];
    if (!outcome) return;
    if ("error" in outcome) {
      if (row.keyVersion) messages.set(row.id, message(row, ctx, row.senderId, UNDECRYPTABLE_TEXT));
      return;
    }
    const { event } = outcome;
    if (event.type !== "message") return;
    const content = event.content ?? {};
    if (content.contentType === "edit") {
      if (content.targetMessageSequenceId && content.updatedText !== undefined) edits.push({ order: eventSortKey(row.id), target: content.targetMessageSequenceId, text: content.updatedText });
      return;
    }
    if (content.contentType !== undefined && content.contentType !== "text") return;
    const hasAttachments = Boolean(event.attachments?.length || content.attachments?.length);
    const text = content.text ?? "";
    if (!text && !hasAttachments) return;
    const sentAt = typeof event.createdAtMsec === "number" ? new Date(event.createdAtMsec).toISOString() : undefined;
    messages.set(row.id, message(row, ctx, event.senderId ?? row.senderId, text || ATTACHMENT_TEXT, sentAt));
  });
  for (const edit of edits.sort((a, b) => (a.order < b.order ? -1 : 1))) {
    const target = messages.get(edit.target);
    if (target && target.text !== UNDECRYPTABLE_TEXT) target.text = edit.text;
  }
  return [...messages.values()].sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : a.id < b.id ? 1 : -1));
}

// The locked inbox row with what the device decrypted laid over it.
export function unlockedConversation(conversation: Conversation, messages: Message[]): Conversation {
  const { unavailable: _locked, ...rest } = conversation;
  const lastMessage = messages[0];
  if (!lastMessage) return rest;
  return { ...rest, lastMessage, updatedAt: lastMessage.sentAt > rest.updatedAt ? lastMessage.sentAt : rest.updatedAt };
}

function message(row: ChatEventRow, ctx: { conversationId: Id; meId: string; people: Map<string, Person> }, senderId: string | null | undefined, text: string, sentAt?: string): Message {
  const sender = senderId ?? "unknown";
  return {
    id: `x:${row.id}`,
    conversationId: ctx.conversationId,
    sender: ctx.people.get(sender) ?? { id: `x:${sender}`, platform: "x", handle: "", displayName: "" },
    isMine: sender === ctx.meId,
    sentAt: sentAt ?? row.createdAt ?? new Date(0).toISOString(),
    text,
    media: [],
  };
}
