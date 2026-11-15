import { ConnectorFailure, type Id } from "../types";
import type { TlObject } from "./transport";

// Conversation ids name the Telegram peer: telegram:user:<id> (a 1:1 chat),
// telegram:chat:<id> (a basic group), telegram:channel:<id> (a supergroup).
// Message ids add the message number, which is only unique per peer for
// supergroups: telegram:<peer>:<message id>. Person ids are telegram:user:<id>.
export type PeerKind = "user" | "chat" | "channel";
export interface PeerRef {
  kind: PeerKind;
  id: string;
}

export const peerKey = (p: PeerRef) => `${p.kind}:${p.id}`;
export const conversationId = (p: PeerRef): Id => `telegram:${peerKey(p)}`;
export const messageId = (p: PeerRef, id: number): Id => `telegram:${peerKey(p)}:${id}`;
export const personId = (userId: string): Id => `telegram:user:${userId}`;

export function peerOf(peer: TlObject): PeerRef {
  switch (peer._) {
    case "peerUser":
      return { kind: "user", id: String(peer.userId) };
    case "peerChat":
      return { kind: "chat", id: String(peer.chatId) };
    case "peerChannel":
      return { kind: "channel", id: String(peer.channelId) };
    default:
      throw new ConnectorFailure({ kind: "platform", message: `Unknown Telegram peer ${peer._}` });
  }
}

const CONVERSATION = /^telegram:(user|chat|channel):(\d+)$/;
const MESSAGE = /^telegram:(user|chat|channel):(\d+):(\d+)$/;

export function parseConversationId(id: string): PeerRef {
  const m = CONVERSATION.exec(id);
  if (!m) throw new ConnectorFailure({ kind: "platform", message: `Not a Telegram conversation id: ${id}` });
  return { kind: m[1] as PeerKind, id: m[2]! };
}

export function parseMessageId(id: string): { peer: PeerRef; id: number } {
  const m = MESSAGE.exec(id);
  if (!m) throw new ConnectorFailure({ kind: "platform", message: `Not a Telegram message id: ${id}` });
  return { peer: { kind: m[1] as PeerKind, id: m[2]! }, id: Number(m[3]) };
}
