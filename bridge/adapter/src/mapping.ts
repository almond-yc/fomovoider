// Pure mapping from bridged Matrix rooms and events to the connector
// contract's Conversation, Message and Person.
import type { Conversation, Id, Message, Person } from "../../../src/connectors/types.js";
import type { BridgeConfig } from "./bridges.js";
import type { MatrixEvent } from "./matrix.js";

export const BRIDGE_STATE_TYPES = ["m.bridge", "uk.half-shot.bridge"];

export interface Member {
  displayName?: string;
}

// What the adapter knows about one bridged room (a portal), for one account.
export interface Room {
  roomId: string;
  accountId: string;
  platform: string;
  chatId: string;
  isDm: boolean;
  name?: string;
  createdAt: number;
  botId?: string;
  members: Record<string, Member>;
  lastMessage?: Message;
  lastEventId?: string;
}

export interface Owner {
  mxid: string;
  me?: Person;
}

// The bridge info a mautrix bridge writes into every portal room. Rooms
// without it (the management room, spaces) are not conversations.
export function bridgeInfo(state: MatrixEvent[], bridges: BridgeConfig[]) {
  for (const event of state) {
    if (!BRIDGE_STATE_TYPES.includes(event.type)) continue;
    const protocol = event.content.protocol?.id;
    const chatId = event.content.channel?.id;
    const bridge = bridges.find((b) => b.protocols.includes(protocol));
    if (!bridge || typeof chatId !== "string") continue;
    return {
      platform: bridge.platform,
      chatId,
      isDm:
        event.content["com.beeper.room_type"] === "dm" ||
        event.content["com.beeper.room_type.v2"] === "dm",
      botId: typeof event.content.bridgebot === "string" ? event.content.bridgebot : undefined,
    };
  }
  return undefined;
}

export function roomFromState(
  roomId: string,
  accountId: string,
  state: MatrixEvent[],
  bridges: BridgeConfig[],
): Room | undefined {
  const info = bridgeInfo(state, bridges);
  if (!info) return undefined;
  const created = state.find((event) => event.type === "m.room.create");
  const room: Room = { roomId, accountId, ...info, createdAt: created?.origin_server_ts ?? 0, members: {} };
  for (const event of state) applyState(room, event);
  return room;
}

// Keeps the room's name and membership current. Returns whether anything
// the Conversation shows changed.
export function applyState(room: Room, event: MatrixEvent) {
  if (event.type === "m.room.name") {
    const name = typeof event.content.name === "string" ? event.content.name : undefined;
    const changed = name !== room.name;
    room.name = name;
    return changed;
  }
  if (event.type === "m.room.member" && event.state_key) {
    const joined = event.content.membership === "join" || event.content.membership === "invite";
    if (!joined) {
      const had = event.state_key in room.members;
      delete room.members[event.state_key];
      return had;
    }
    const displayName = typeof event.content.displayname === "string" ? event.content.displayname : undefined;
    const changed = room.members[event.state_key]?.displayName !== displayName || !(event.state_key in room.members);
    room.members[event.state_key] = { displayName };
    return changed;
  }
  return false;
}

// Reverses mautrix's localpart escaping: "_x" is an uppercase letter and
// "=xx" a hex-escaped byte.
export function unescapeLocalpart(localpart: string) {
  const bytes: number[] = [];
  for (let i = 0; i < localpart.length; i++) {
    const char = localpart[i]!;
    if (char === "_" && i + 1 < localpart.length) {
      bytes.push(localpart[++i]!.toUpperCase().charCodeAt(0));
    } else if (char === "=" && /^[0-9a-f]{2}$/.test(localpart.slice(i + 1, i + 3))) {
      bytes.push(parseInt(localpart.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(char.charCodeAt(0));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function ghostRemoteId(mxid: string, bridge: BridgeConfig) {
  const localpart = mxid.slice(1, mxid.indexOf(":"));
  if (!localpart.startsWith(bridge.ghostPrefix)) return undefined;
  return unescapeLocalpart(localpart.slice(bridge.ghostPrefix.length));
}

function ns(platform: string, value: string): Id {
  return `${platform}:${value}`;
}

export function person(mxid: string, room: Room, bridge: BridgeConfig, owner: Owner): Person {
  if (mxid === owner.mxid && owner.me) return owner.me;
  const remoteId = ghostRemoteId(mxid, bridge) ?? mxid;
  return {
    id: ns(room.platform, remoteId),
    platform: room.platform,
    handle: remoteId,
    displayName: room.members[mxid]?.displayName ?? remoteId,
  };
}

function isMine(mxid: string, bridge: BridgeConfig, owner: Owner) {
  if (mxid === owner.mxid) return true;
  const ownId = owner.me?.id.slice(owner.me.platform.length + 1);
  return ownId !== undefined && ghostRemoteId(mxid, bridge) === ownId;
}

const PLACEHOLDERS: Record<string, string> = {
  "m.image": "[photo]",
  "m.video": "[video]",
  "m.audio": "[voice message]",
  "m.file": "[file]",
  "m.location": "[location]",
  "m.sticker": "[sticker]",
};

// Text for a message. Media can't be shown yet (mxc:// URLs need the
// homeserver), so attachments become a caption or a placeholder.
function messageText(content: Record<string, any>, type: string) {
  const msgtype = type === "m.sticker" ? "m.sticker" : content.msgtype;
  const body = typeof content.body === "string" ? content.body : "";
  const placeholder = PLACEHOLDERS[msgtype];
  if (!placeholder) return msgtype === "m.emote" ? `* ${body}` : body;
  const caption = content.filename !== undefined && body !== content.filename ? body : "";
  return caption || placeholder;
}

// A message event as the contract's Message, or undefined for events that
// aren't messages (bridge notices, state, reactions). Edits (m.replace)
// map onto the edited message's id with the new text.
export function toMessage(
  event: MatrixEvent,
  room: Room,
  bridge: BridgeConfig,
  owner: Owner,
  original?: Message,
): Message | undefined {
  if (event.type !== "m.room.message" && event.type !== "m.sticker") return undefined;
  if (event.sender === room.botId) return undefined;
  const relation = event.content["m.relates_to"];
  const edit = relation?.rel_type === "m.replace" && typeof relation.event_id === "string";
  const content = edit ? (event.content["m.new_content"] ?? event.content) : event.content;
  const id = ns(room.platform, edit ? relation.event_id : event.event_id);
  return {
    id,
    conversationId: ns(room.platform, room.chatId),
    sender: original?.sender ?? person(event.sender, room, bridge, owner),
    isMine: original?.isMine ?? isMine(event.sender, bridge, owner),
    sentAt: original?.sentAt ?? new Date(event.origin_server_ts).toISOString(),
    text: messageText(content, event.type),
    media: [],
  };
}

export function toConversation(room: Room, bridge: BridgeConfig, owner: Owner): Conversation {
  const participants = Object.keys(room.members)
    .filter((mxid) => mxid !== owner.mxid && mxid !== room.botId && !isMine(mxid, bridge, owner))
    .map((mxid) => person(mxid, room, bridge, owner));
  return {
    id: ns(room.platform, room.chatId),
    platform: room.platform,
    participants,
    title: room.isDm ? undefined : room.name,
    lastMessage: room.lastMessage,
    updatedAt: room.lastMessage?.sentAt ?? new Date(room.createdAt).toISOString(),
  };
}
