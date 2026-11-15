import {
  type Account,
  type Capabilities,
  type Connector,
  ConnectorFailure,
  type Conversation,
  type Id,
  type ISODate,
  type Login,
  type Media,
  type Message,
  type Page,
  type Person,
  type Post,
  type Session,
} from "../types";
import { toConnectorFailure } from "./errors";
import { type PeerRef, conversationId, messageId, parseConversationId, parseMessageId, peerKey, peerOf } from "./ids";
import { type Entities, TelegramMapper, mapUser } from "./mappers";
import { MemoryPeerStore, type PeerStore, type SessionStore } from "./sessions";
import type { TelegramClient, TelegramTransport, TlObject } from "./transport";

export interface TelegramConnectorOptions {
  transport: TelegramTransport;
  sessions: SessionStore;
  peers?: PeerStore;
  login?: Login;
  now?: () => number;
}

const MAX_PAGE = 100;
// How far conversations() and send() look through the chat list for a peer
// whose access hash isn't known yet.
const PEER_SCAN_PAGES = 5;
const DIALOG_CURSOR = "d1";
const HISTORY_CURSOR = "m1";

const noLogin: Login = {
  kind: "steps",
  methods: [],
  start: () => Promise.reject(new ConnectorFailure({ kind: "platform", message: "No Telegram login configured" })),
  next: () => Promise.reject(new ConnectorFailure({ kind: "platform", message: "No Telegram login configured" })),
  cancel: async () => undefined,
};

interface DialogCursor {
  offsetDate: number;
  offsetId: number;
  peer: PeerRef;
}

function parseDialogCursor(cursor: string | undefined): DialogCursor | undefined {
  if (!cursor) return undefined;
  const [prefix, date, id, kind, peerId] = cursor.split(/[|:]/);
  if (prefix !== DIALOG_CURSOR || !date || !id || !kind || !peerId) {
    throw new ConnectorFailure({ kind: "platform", message: `Unrecognized Telegram chat list cursor: ${cursor}` });
  }
  return { offsetDate: Number(date), offsetId: Number(id), peer: { kind: kind as PeerRef["kind"], id: peerId } };
}

function parseHistoryCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const [prefix, id] = cursor.split("|");
  if (prefix !== HISTORY_CURSOR || !id || !/^\d+$/.test(id)) {
    throw new ConnectorFailure({ kind: "platform", message: `Unrecognized Telegram message cursor: ${cursor}` });
  }
  return Number(id);
}

export class TelegramConnector implements Connector {
  readonly platform = "telegram" as const;
  readonly displayName = "Telegram";
  readonly capabilities: Capabilities = { feed: false, chats: true, sendMessage: true, sendMedia: false, reply: false };
  readonly login: Login;

  private readonly peers: PeerStore;
  private readonly now: () => number;
  private readonly clients = new Map<string, Promise<TelegramClient>>();
  private readonly mes = new Map<string, Person>();

  constructor(private readonly opts: TelegramConnectorOptions) {
    this.login = opts.login ?? noLogin;
    this.peers = opts.peers ?? new MemoryPeerStore();
    this.now = opts.now ?? Date.now;
  }

  // Disconnects every client this connector opened. Call it when done (the
  // end of a sync action); calls after close() reconnect.
  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map(async (c) => (await c.catch(() => undefined))?.disconnect().catch(() => undefined)));
  }

  async account(session: Session): Promise<Account> {
    return this.call(session, async (client, deviceId) => {
      this.mes.delete(deviceId);
      return { platform: "telegram", me: await this.me(client, deviceId) };
    });
  }

  feed(_session: Session, _opts: { since: string | ISODate; limit: number }): Promise<Page<Post>> {
    return Promise.reject(new ConnectorFailure({ kind: "unsupported", capability: "feed" }));
  }

  // The chat list, most recent first: 1:1 chats, groups and supergroups.
  // Broadcast channels, Saved Messages and the archive folder are left out;
  // secret chats never appear (they exist only on the devices that hold them).
  async conversations(session: Session, opts: { cursor?: string; limit: number }): Promise<Page<Conversation>> {
    return this.call(session, async (client, deviceId) => {
      const me = await this.me(client, deviceId);
      const offset = parseDialogCursor(opts.cursor);
      const limit = Math.max(1, Math.min(MAX_PAGE, opts.limit));
      const res = await this.dialogs(client, deviceId, offset, limit);
      const mapper = new TelegramMapper(me, res);
      const all = (res.dialogs as TlObject[] | undefined) ?? [];
      const dialogs = all.filter((d) => d._ === "dialog");
      const tops = topMessages(res);
      const items = dialogs
        .filter((d) => mapper.isConversation(peerOf(d.peer as TlObject)))
        .map((d) => mapper.conversation(d, tops.get(`${peerKey(peerOf(d.peer as TlObject))}:${d.topMessage}`)));
      const last = dialogs.at(-1);
      const lastTop = last && tops.get(`${peerKey(peerOf(last.peer as TlObject))}:${last.topMessage}`);
      const caughtUp = res._ === "messages.dialogs" || all.length < limit || !lastTop;
      return {
        items,
        cursor: caughtUp || !last || !lastTop ? "" : [DIALOG_CURSOR, lastTop.date, lastTop.id, peerKey(peerOf(last.peer as TlObject))].join("|"),
        caughtUp,
      };
    });
  }

  // One conversation as the chat list shows it now (unread count, last message).
  async conversation(session: Session, id: Id): Promise<Conversation> {
    const peer = parseConversationId(id);
    return this.call(session, async (client, deviceId) => {
      const me = await this.me(client, deviceId);
      const inputPeer = await this.inputPeer(client, deviceId, peer);
      const res = await client.invoke({ _: "messages.getPeerDialogs", peers: [{ _: "inputDialogPeer", peer: inputPeer }] });
      await this.learn(deviceId, res);
      const dialog = ((res.dialogs as TlObject[] | undefined) ?? []).find((d) => d._ === "dialog");
      if (!dialog) throw new ConnectorFailure({ kind: "platform", message: "Telegram doesn't know this chat." });
      return new TelegramMapper(me, res).conversation(dialog, topMessages(res).get(`${peerKey(peer)}:${dialog.topMessage}`));
    });
  }

  // Newest first. `after` (a message id) stops at that message, for
  // incremental syncs; `cursor` pages to older messages.
  async messages(session: Session, conversation: Id, opts: { cursor?: string; limit: number; after?: Id }): Promise<Page<Message>> {
    const peer = parseConversationId(conversation);
    const minId = opts.after ? parseMessageId(opts.after).id : 0;
    const offsetId = parseHistoryCursor(opts.cursor);
    const limit = Math.max(1, Math.min(MAX_PAGE, opts.limit));
    return this.call(session, async (client, deviceId) => {
      const me = await this.me(client, deviceId);
      const res = await this.history(client, deviceId, peer, { offsetId, limit, minId });
      const mapper = new TelegramMapper(me, res);
      const raw = (res.messages as TlObject[] | undefined) ?? [];
      const items = raw
        .map((m) => mapper.message(m))
        .filter((m): m is Message => m !== undefined)
        .sort((a, b) => parseMessageId(b.id).id - parseMessageId(a.id).id);
      const oldest = raw.reduce((min, m) => Math.min(min, m.id as number), Number.POSITIVE_INFINITY);
      const caughtUp = res._ === "messages.messages" || raw.length < limit;
      return { items, cursor: caughtUp || !Number.isFinite(oldest) ? "" : `${HISTORY_CURSOR}|${oldest}`, caughtUp };
    });
  }

  // Text only. Runs once per call and is never retried.
  async send(session: Session, conversation: Id, draft: { text: string; media?: Media[] }): Promise<Message> {
    if (draft.media?.length) throw new ConnectorFailure({ kind: "unsupported", capability: "sendMedia" });
    if (!draft.text.trim()) throw new ConnectorFailure({ kind: "platform", message: "Message text is empty" });
    const peer = parseConversationId(conversation);
    return this.call(session, async (client, deviceId) => {
      const me = await this.me(client, deviceId);
      const inputPeer = await this.inputPeer(client, deviceId, peer);
      const res = await client.invoke({ _: "messages.sendMessage", peer: inputPeer, message: draft.text });
      return this.sentMessage(res, me, peer, draft.text);
    });
  }

  // Marks everything in the conversation as read, as opening it in Telegram does.
  async markRead(session: Session, conversation: Id): Promise<void> {
    const peer = parseConversationId(conversation);
    await this.call(session, async (client, deviceId) => {
      const latest = await this.history(client, deviceId, peer, { offsetId: 0, limit: 1, minId: 0 });
      const maxId = ((latest.messages as TlObject[] | undefined) ?? []).reduce((max, m) => Math.max(max, m.id as number), 0);
      if (!maxId) return;
      if (peer.kind === "channel") {
        const inputPeer = await this.inputPeer(client, deviceId, peer);
        await client.invoke({ _: "channels.readHistory", channel: { _: "inputChannel", channelId: peer.id, accessHash: inputPeer.accessHash }, maxId });
      } else {
        await client.invoke({ _: "messages.readHistory", peer: await this.inputPeer(client, deviceId, peer), maxId });
      }
    });
  }

  private sentMessage(res: TlObject, me: Person, peer: PeerRef, text: string): Message {
    if (res._ === "updateShortSentMessage") {
      return { id: messageId(peer, res.id as number), conversationId: conversationId(peer), sender: me, isMine: true, sentAt: new Date((res.date as number) * 1000).toISOString(), text, media: [] };
    }
    const updates = (res.updates as TlObject[] | undefined) ?? [];
    const mapper = new TelegramMapper(me, res as Entities);
    for (const u of updates) {
      if (u._ !== "updateNewMessage" && u._ !== "updateNewChannelMessage") continue;
      const msg = u.message as TlObject;
      if (msg._ !== "message" || msg.out !== true || peerKey(peerOf(msg.peerId as TlObject)) !== peerKey(peer)) continue;
      const mapped = mapper.message(msg);
      if (mapped) return mapped;
    }
    const sentId = updates.find((u) => u._ === "updateMessageID")?.id as number | undefined;
    if (sentId === undefined) throw new ConnectorFailure({ kind: "platform", message: "Telegram didn't confirm the message" }, undefined, { cause: res });
    return { id: messageId(peer, sentId), conversationId: conversationId(peer), sender: me, isMine: true, sentAt: new Date(this.now()).toISOString(), text, media: [] };
  }

  private async dialogs(client: TelegramClient, deviceId: string, offset: DialogCursor | undefined, limit: number): Promise<TlObject> {
    const offsetPeer = offset ? await this.inputPeer(client, deviceId, offset.peer) : { _: "inputPeerEmpty" };
    const res = await client.invoke<TlObject>({
      _: "messages.getDialogs",
      offsetDate: offset?.offsetDate ?? 0,
      offsetId: offset?.offsetId ?? 0,
      offsetPeer,
      limit,
      hash: "0",
    });
    await this.learn(deviceId, res);
    return res;
  }

  private async history(client: TelegramClient, deviceId: string, peer: PeerRef, opts: { offsetId: number; limit: number; minId: number }): Promise<TlObject> {
    const res = await client.invoke<TlObject>({
      _: "messages.getHistory",
      peer: await this.inputPeer(client, deviceId, peer),
      offsetId: opts.offsetId,
      offsetDate: 0,
      addOffset: 0,
      limit: opts.limit,
      maxId: 0,
      minId: opts.minId,
      hash: "0",
    });
    await this.learn(deviceId, res);
    return res;
  }

  private async inputPeer(client: TelegramClient, deviceId: string, peer: PeerRef): Promise<TlObject> {
    if (peer.kind === "chat") return { _: "inputPeerChat", chatId: peer.id };
    const key = peerKey(peer);
    let hash = (await this.peers.get(deviceId, [key]))[key];
    let offset: DialogCursor | undefined;
    for (let page = 0; hash === undefined && page < PEER_SCAN_PAGES; page++) {
      const res = await this.dialogs(client, deviceId, offset, MAX_PAGE);
      hash = hashesOf(res)[key];
      const dialogs = ((res.dialogs as TlObject[] | undefined) ?? []).filter((d) => d._ === "dialog");
      const last = dialogs.at(-1);
      const top = last && topMessages(res).get(`${peerKey(peerOf(last.peer as TlObject))}:${last.topMessage}`);
      if (res._ === "messages.dialogs" || !last || !top) break;
      offset = { offsetDate: top.date as number, offsetId: top.id as number, peer: peerOf(last.peer as TlObject) };
    }
    if (hash === undefined) throw new ConnectorFailure({ kind: "platform", message: "Telegram doesn't know this chat." });
    return peer.kind === "user" ? { _: "inputPeerUser", userId: peer.id, accessHash: hash } : { _: "inputPeerChannel", channelId: peer.id, accessHash: hash };
  }

  private async learn(deviceId: string, result: Entities) {
    const hashes = hashesOf(result);
    if (Object.keys(hashes).length) await this.peers.put(deviceId, hashes);
  }

  private async me(client: TelegramClient, deviceId: string): Promise<Person> {
    const cached = this.mes.get(deviceId);
    if (cached) return cached;
    const [user] = await client.invoke<TlObject[]>({ _: "users.getUsers", id: [{ _: "inputUserSelf" }] });
    if (!user || user._ !== "user") throw new ConnectorFailure({ kind: "session_expired" });
    const me = mapUser(user);
    this.mes.set(deviceId, me);
    return me;
  }

  private async call<T>(session: Session, run: (client: TelegramClient, deviceId: string) => Promise<T>): Promise<T> {
    if (session.platform !== "telegram" || session.kind !== "device") throw new ConnectorFailure({ kind: "session_expired" }, "Telegram needs a device session");
    const { deviceId } = session;
    try {
      return await run(await this.client(deviceId), deviceId);
    } catch (err) {
      throw toConnectorFailure(err, this.now);
    }
  }

  private client(deviceId: string): Promise<TelegramClient> {
    let client = this.clients.get(deviceId);
    if (!client) {
      client = (async () => {
        const stored = await this.opts.sessions.load(deviceId);
        if (!stored) throw new ConnectorFailure({ kind: "session_expired" }, "No stored Telegram session");
        return this.opts.transport.connect(stored);
      })();
      client.catch(() => this.clients.delete(deviceId));
      this.clients.set(deviceId, client);
    }
    return client;
  }
}

function topMessages(res: TlObject): Map<string, TlObject> {
  const tops = new Map<string, TlObject>();
  for (const m of (res.messages as TlObject[] | undefined) ?? []) {
    if (m._ === "messageEmpty" || !m.peerId) continue;
    tops.set(`${peerKey(peerOf(m.peerId as TlObject))}:${m.id}`, m);
  }
  return tops;
}

// Access hashes from a result's users and channels. "min" entities carry a
// hash that only works in the context they came from, so they are skipped.
function hashesOf(result: Entities): Record<string, string> {
  const out: Record<string, string> = {};
  for (const u of result.users ?? []) if (u._ === "user" && !u.min && u.accessHash !== undefined && u.accessHash !== null) out[`user:${u.id}`] = String(u.accessHash);
  for (const c of result.chats ?? []) {
    if ((c._ === "channel" && !c.min) || c._ === "channelForbidden") {
      if (c.accessHash !== undefined && c.accessHash !== null) out[`channel:${c.id}`] = String(c.accessHash);
    }
  }
  return out;
}
