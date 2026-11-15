import { afterEach, describe, expect, it } from "vitest";
import { TelegramRpcError } from "../transport";
import { fixture, setup } from "./helpers";

const BOB = "telegram:user:5000000002";
const CLUB = "telegram:channel:1500000001";
const FAMILY = "telegram:chat:4000001";
const CAROL = "telegram:user:5000000003";

const me = {
  id: "telegram:user:5000000001",
  platform: "telegram",
  handle: "ada_l",
  displayName: "Ada Lovelace",
  profileUrl: "https://t.me/ada_l",
};

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

function connected(opts?: Parameters<typeof setup>[0]) {
  const s = setup(opts);
  cleanup.push(() => s.connector.close());
  return s;
}

describe("TelegramConnector", () => {
  it("declares chats only", () => {
    const { connector } = connected();
    expect(connector.capabilities).toEqual({ feed: false, chats: true, sendMessage: true, sendMedia: false, reply: false });
    expect(connector.platform).toBe("telegram");
  });

  it("returns the account owner", async () => {
    const { connector, session } = connected();
    expect(await connector.account(session)).toEqual({ platform: "telegram", me });
  });

  it("refuses the feed as unsupported", async () => {
    const { connector, session } = connected();
    await expect(connector.feed(session, { since: "2025-11-14T00:00:00Z", limit: 10 })).rejects.toMatchObject({ error: { kind: "unsupported", capability: "feed" } });
  });

  it("lists chats and groups, without broadcast channels, Saved Messages or folders", async () => {
    const { connector, session } = connected();
    const page = await connector.conversations(session, { limit: 20 });
    expect(page.caughtUp).toBe(true);
    expect(page.cursor).toBe("");
    expect(page.items.map((c) => c.id)).toEqual([BOB, CLUB, FAMILY, CAROL]);
    const [bob, club, family, carol] = page.items;
    expect(bob).toEqual({
      id: BOB,
      platform: "telegram",
      participants: [{ id: BOB, platform: "telegram", handle: "bobby", displayName: "Bob Stone", profileUrl: "https://t.me/bobby" }],
      lastMessage: {
        id: `${BOB}:105`,
        conversationId: BOB,
        sender: { id: BOB, platform: "telegram", handle: "bobby", displayName: "Bob Stone", profileUrl: "https://t.me/bobby" },
        isMine: false,
        sentAt: "2025-11-15T19:59:00.000Z",
        text: "Are we still on for Tuesday?",
        media: [],
        raw: expect.anything(),
      },
      unreadCount: 2,
      updatedAt: "2025-11-15T19:59:00.000Z",
    });
    expect(club).toMatchObject({ title: "Book club", participants: [], unreadCount: 0, lastMessage: { sender: { displayName: "Carol", handle: "carol_reads" } } });
    expect(family).toMatchObject({ title: "Family", lastMessage: { isMine: true, sender: me, text: "Landing at 6" } });
    expect(carol).toMatchObject({ unreadCount: 1, lastMessage: { text: "[Photo]" } });
  });

  it("pages the chat list with an offset cursor", async () => {
    const { connector, session, transport } = connected();
    const slice = { ...fixture("dialogs"), _: "messages.dialogsSlice", count: 50 };
    transport.on("messages.getDialogs", () => slice, () => ({ _: "messages.dialogsSlice", count: 50, dialogs: [], messages: [], chats: [], users: [] }));
    const first = await connector.conversations(session, { limit: 7 });
    expect(first.caughtUp).toBe(false);
    expect(first.cursor).toBe("d1|1763229600|100|user:5000000003");
    const second = await connector.conversations(session, { cursor: first.cursor, limit: 7 });
    expect(second).toEqual({ items: [], cursor: "", caughtUp: true });
    expect(transport.callsTo("messages.getDialogs")[1]).toMatchObject({
      offsetDate: 1763229600,
      offsetId: 100,
      offsetPeer: { _: "inputPeerUser", userId: "5000000003", accessHash: "9100000000000000003" },
      limit: 7,
    });
  });

  it("reads messages newest first, skipping service messages, with media named in the text", async () => {
    const { connector, session, transport } = connected();
    await connector.conversations(session, { limit: 20 });
    const page = await connector.messages(session, BOB, { limit: 20 });
    expect(page.caughtUp).toBe(true);
    expect(page.items.map((m) => [m.id, m.isMine, m.text])).toEqual([
      [`${BOB}:105`, false, "Are we still on for Tuesday?"],
      [`${BOB}:103`, true, "Sure, 7pm works"],
      [`${BOB}:102`, false, "[Photo] Look at this view"],
    ]);
    expect(transport.callsTo("messages.getHistory")[0]).toMatchObject({ peer: { _: "inputPeerUser", userId: "5000000002", accessHash: "9100000000000000002" }, minId: 0, limit: 20 });
  });

  it("names supergroup senders, including the group posting as itself", async () => {
    const { connector, session } = connected();
    const page = await connector.messages(session, CLUB, { limit: 20 });
    expect(page.items.map((m) => [m.id, m.sender.displayName, m.text])).toEqual([
      [`${CLUB}:9001`, "Carol", "Chapter 4 by Sunday, please"],
      [`${CLUB}:9000`, "Dave", "[Sticker 👍]"],
      [`${CLUB}:8999`, "Book club", "Welcome to the club"],
    ]);
    expect(page.items[2]!.sender.id).toBe(CLUB);
  });

  it("pages older messages and stops at `after` for incremental syncs", async () => {
    const { connector, session, transport } = connected();
    const first = await connector.messages(session, CLUB, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.caughtUp).toBe(false);
    expect(first.cursor).toBe("m1|9000");
    const older = await connector.messages(session, CLUB, { cursor: first.cursor, limit: 2 });
    expect(older.items.map((m) => m.id)).toEqual([`${CLUB}:8999`]);
    expect(older.caughtUp).toBe(true);
    const since = await connector.messages(session, CLUB, { after: `${CLUB}:9000`, limit: 50 });
    expect(since.items.map((m) => m.id)).toEqual([`${CLUB}:9001`]);
    expect(transport.callsTo("messages.getHistory").at(-1)).toMatchObject({ minId: 9000 });
  });

  it("finds an unknown peer's access hash in the chat list, then remembers it", async () => {
    const { connector, session, transport, peers } = connected();
    await connector.messages(session, BOB, { limit: 5 });
    expect(transport.callsTo("messages.getDialogs")).toHaveLength(1);
    expect(await peers.get("device-1", ["user:5000000002", "channel:1500000001"])).toEqual({
      "user:5000000002": "9100000000000000002",
      "channel:1500000001": "9200000000000000001",
    });
    await connector.messages(session, BOB, { limit: 5 });
    expect(transport.callsTo("messages.getDialogs")).toHaveLength(1);
  });

  it("does not learn hashes from min users", async () => {
    const { connector, session, peers } = connected();
    await connector.messages(session, CLUB, { limit: 5 });
    expect(await peers.get("device-1", ["user:5000000004"])).toEqual({});
  });

  it("fails clearly for a chat it can't find", async () => {
    const { connector, session } = connected();
    await expect(connector.messages(session, "telegram:user:42", { limit: 5 })).rejects.toMatchObject({ error: { kind: "platform", message: "Telegram doesn't know this chat." } });
  });

  it("sends text to a user and returns my message", async () => {
    const { connector, session, transport } = connected();
    const { raw: _raw, ...msg } = await connector.send(session, BOB, { text: "Yes, see you then" });
    expect(transport.callsTo("messages.sendMessage")[0]).toMatchObject({ peer: { _: "inputPeerUser", userId: "5000000002" }, message: "Yes, see you then" });
    expect(msg).toEqual({ id: `${BOB}:106`, conversationId: BOB, sender: me, isMine: true, sentAt: "2025-11-15T20:00:00.000Z", text: "Yes, see you then", media: [] });
  });

  it("sends to a supergroup and reads the message from the updates", async () => {
    const { connector, session } = connected();
    const { raw: _raw, ...msg } = await connector.send(session, CLUB, { text: "See you Sunday" });
    expect(msg).toMatchObject({ id: `${CLUB}:9002`, conversationId: CLUB, isMine: true, sender: me, text: "See you Sunday" });
  });

  it("refuses media, empty text and other platforms' ids", async () => {
    const { connector, session, transport } = connected();
    await expect(connector.send(session, BOB, { text: "x", media: [{ kind: "image", url: "file://a.jpg" }] })).rejects.toMatchObject({ error: { kind: "unsupported", capability: "sendMedia" } });
    await expect(connector.send(session, BOB, { text: "  " })).rejects.toMatchObject({ error: { kind: "platform" } });
    await expect(connector.send(session, "x:123", { text: "hi" })).rejects.toMatchObject({ error: { kind: "platform" } });
    expect(transport.callsTo("messages.sendMessage")).toHaveLength(0);
  });

  it("never retries a failed send", async () => {
    const { connector, session, transport } = connected();
    transport.on("messages.sendMessage", () => {
      throw new TelegramRpcError(400, "USER_IS_BLOCKED");
    });
    await expect(connector.send(session, BOB, { text: "hi" })).rejects.toMatchObject({ error: { kind: "platform", message: "This person has blocked you." } });
    expect(transport.callsTo("messages.sendMessage")).toHaveLength(1);
  });

  it("marks a chat read up to its newest message", async () => {
    const { connector, session, transport } = connected();
    await connector.markRead!(session, BOB);
    expect(transport.callsTo("messages.readHistory")[0]).toMatchObject({ peer: { _: "inputPeerUser", userId: "5000000002" }, maxId: 105 });
    await connector.markRead!(session, CLUB);
    expect(transport.callsTo("channels.readHistory")[0]).toMatchObject({ channel: { _: "inputChannel", channelId: "1500000001", accessHash: "9200000000000000001" }, maxId: 9001 });
  });

  it("reads one conversation as the chat list shows it", async () => {
    const { connector, session } = connected();
    expect(await connector.conversation(session, BOB)).toMatchObject({ id: BOB, unreadCount: 0, lastMessage: { id: `${BOB}:105` } });
  });

  it("opens one connection per session and closes it", async () => {
    const { connector, session, transport } = setup();
    await connector.account(session);
    await connector.conversations(session, { limit: 5 });
    await connector.messages(session, BOB, { limit: 5 });
    expect(transport.connects).toBe(1);
    await connector.close();
    expect(transport.disconnects).toBe(1);
  });
});

describe("errors", () => {
  it("maps a revoked session to session_expired", async () => {
    const { connector, session, transport } = connected();
    transport.on("users.getUsers", () => {
      throw new TelegramRpcError(401, "SESSION_REVOKED");
    });
    await expect(connector.account(session)).rejects.toMatchObject({ error: { kind: "session_expired" } });
  });

  it("maps a missing stored session and a non-device session to session_expired", async () => {
    const { connector } = connected();
    await expect(connector.account({ platform: "telegram", kind: "device", deviceId: "gone" })).rejects.toMatchObject({ error: { kind: "session_expired" } });
    await expect(connector.account({ platform: "telegram", kind: "oauth", accessToken: "x" })).rejects.toMatchObject({ error: { kind: "session_expired" } });
  });

  it("maps FLOOD_WAIT to rate_limited with retryAt", async () => {
    const { connector, session, transport } = connected();
    transport.on("messages.getDialogs", () => {
      throw new TelegramRpcError(420, "FLOOD_WAIT_30");
    });
    await expect(connector.conversations(session, { limit: 5 })).rejects.toMatchObject({ error: { kind: "rate_limited", retryAt: "2025-11-15T20:00:30.000Z" } });
  });

  it("maps transport failures to network", async () => {
    const { connector, session, transport } = connected();
    transport.on("users.getUsers", () => {
      throw new Error("ECONNRESET");
    });
    await expect(connector.account(session)).rejects.toMatchObject({ error: { kind: "network" } });
  });
});
