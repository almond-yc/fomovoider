import type { Conversation, Message, Person } from "../types";
import { type PeerRef, conversationId, messageId, peerKey, peerOf, personId } from "./ids";
import type { TlObject } from "./transport";

// A Telegram result with the users and chats it references (messages.dialogs,
// messages.messages, updates, ...).
export interface Entities {
  users?: TlObject[];
  chats?: TlObject[];
  [field: string]: unknown;
}

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

export function mapUser(user: TlObject): Person {
  const username = primaryUsername(user);
  const name = [user.firstName, user.lastName].filter((s) => typeof s === "string" && s.trim()).join(" ").trim();
  return {
    id: personId(String(user.id)),
    platform: "telegram",
    handle: username ?? "",
    displayName: user.deleted ? "Deleted Account" : name || (username ?? "Telegram user"),
    ...(username ? { profileUrl: `https://t.me/${username}` } : {}),
  };
}

function primaryUsername(peer: TlObject): string | undefined {
  if (typeof peer.username === "string" && peer.username) return peer.username;
  const active = (peer.usernames as TlObject[] | undefined)?.find((u) => u.active);
  return typeof active?.username === "string" ? active.username : undefined;
}

// A chat or channel posting in a supergroup as itself (anonymous admins,
// linked channels) is the message's sender.
function mapChatAsPerson(chat: TlObject): Person {
  const username = primaryUsername(chat);
  return {
    id: `telegram:${chat._ === "chat" || chat._ === "chatForbidden" ? "chat" : "channel"}:${chat.id}`,
    platform: "telegram",
    handle: username ?? "",
    displayName: String(chat.title ?? "Telegram chat"),
    ...(username ? { profileUrl: `https://t.me/${username}` } : {}),
  };
}

export class TelegramMapper {
  private readonly users = new Map<string, TlObject>();
  private readonly chats = new Map<string, TlObject>();

  constructor(
    private readonly me: Person,
    ...results: Entities[]
  ) {
    for (const r of results) this.add(r);
  }

  add(result: Entities) {
    for (const u of result.users ?? []) if (u._ === "user") this.users.set(String(u.id), u);
    for (const c of result.chats ?? []) this.chats.set(`${c._ === "chat" || c._ === "chatForbidden" ? "chat" : "channel"}:${c.id}`, c);
  }

  entity(peer: PeerRef): TlObject | undefined {
    return peer.kind === "user" ? this.users.get(peer.id) : this.chats.get(peerKey(peer));
  }

  // Chats only: broadcast channels are one-way feeds, and Saved Messages is a
  // chat with yourself, so neither is a conversation.
  isConversation(peer: PeerRef): boolean {
    if (peer.kind === "user") return `telegram:user:${peer.id}` !== this.me.id;
    const chat = this.entity(peer);
    return !(chat?.broadcast === true);
  }

  // Undefined for service messages (joins, pins, calls, ...) and empty slots.
  message(msg: TlObject): Message | undefined {
    if (msg._ !== "message") return undefined;
    const peer = peerOf(msg.peerId as TlObject);
    const isMine = msg.out === true;
    return {
      id: messageId(peer, msg.id as number),
      conversationId: conversationId(peer),
      sender: isMine ? this.me : this.sender(msg, peer),
      isMine,
      sentAt: iso(msg.date as number),
      text: messageText(msg),
      media: [],
      raw: msg,
    };
  }

  private sender(msg: TlObject, peer: PeerRef): Person {
    const from = msg.fromId ? peerOf(msg.fromId as TlObject) : peer;
    const entity = this.entity(from);
    if (from.kind === "user") return entity ? mapUser(entity) : { id: personId(from.id), platform: "telegram", handle: "", displayName: "Telegram user" };
    return entity ? mapChatAsPerson(entity) : { id: conversationId(from), platform: "telegram", handle: "", displayName: "Telegram chat" };
  }

  conversation(dialog: TlObject, top: TlObject | undefined): Conversation {
    const peer = peerOf(dialog.peer as TlObject);
    const entity = this.entity(peer);
    const lastMessage = top ? this.message(top) : undefined;
    const participants = peer.kind === "user" && entity ? [mapUser(entity)] : [];
    return {
      id: conversationId(peer),
      platform: "telegram",
      participants,
      ...(peer.kind !== "user" && entity?.title ? { title: String(entity.title) } : {}),
      ...(lastMessage ? { lastMessage } : {}),
      unreadCount: (dialog.unreadCount as number | undefined) ?? 0,
      ...(entity?._ === "chatForbidden" || entity?._ === "channelForbidden" ? { unavailable: { reason: "unsupported" } } : {}),
      updatedAt: iso((top?.date as number | undefined) ?? 0),
    };
  }
}

// Media isn't downloaded (it lives behind MTProto, not URLs), so the text
// names what was attached, followed by the caption.
export function messageText(msg: TlObject): string {
  const text = typeof msg.message === "string" ? msg.message : "";
  const label = mediaLabel(msg.media as TlObject | undefined);
  if (!label) return text;
  return text ? `[${label}] ${text}` : `[${label}]`;
}

function mediaLabel(media: TlObject | undefined): string | undefined {
  if (!media) return undefined;
  switch (media._) {
    case "messageMediaPhoto":
      return "Photo";
    case "messageMediaGeo":
    case "messageMediaGeoLive":
    case "messageMediaVenue":
      return "Location";
    case "messageMediaContact":
      return "Contact";
    case "messageMediaPoll": {
      const question = (media.poll as TlObject | undefined)?.question as TlObject | string | undefined;
      const q = typeof question === "string" ? question : (question?.text as string | undefined);
      return q ? `Poll: ${q}` : "Poll";
    }
    case "messageMediaDice":
      return String(media.emoticon ?? "Dice");
    case "messageMediaDocument":
      return documentLabel(media.document as TlObject | undefined, media);
    case "messageMediaWebPage":
    case "messageMediaEmpty":
      return undefined;
    default:
      return "Attachment";
  }
}

function documentLabel(doc: TlObject | undefined, media: TlObject): string {
  const attrs = (doc?.attributes as TlObject[] | undefined) ?? [];
  const has = (name: string) => attrs.find((a) => a._ === name);
  const sticker = has("documentAttributeSticker");
  if (sticker) return sticker.alt ? `Sticker ${sticker.alt}` : "Sticker";
  if (has("documentAttributeAnimated")) return "GIF";
  const video = has("documentAttributeVideo");
  if (video) return video.roundMessage ? "Video message" : "Video";
  const audio = has("documentAttributeAudio");
  if (audio) return audio.voice || media.voice ? "Voice message" : "Audio";
  const file = has("documentAttributeFilename");
  return file?.fileName ? `File: ${file.fileName}` : "File";
}
