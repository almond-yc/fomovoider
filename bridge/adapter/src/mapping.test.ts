import assert from "node:assert/strict";
import { test } from "node:test";
import type { BridgeConfig } from "./bridges.js";
import { roomFromState, toConversation, toMessage, unescapeLocalpart } from "./mapping.js";
import type { MatrixEvent } from "./matrix.js";

const bridge: BridgeConfig = {
  platform: "whatsapp",
  url: "http://whatsapp",
  asToken: "as",
  provisioningSecret: "secret",
  ghostPrefix: "whatsapp_",
  protocols: ["whatsapp"],
};
const owner = {
  mxid: "@fv_acc1:bridge.local",
  me: { id: "whatsapp:15550000001" as const, platform: "whatsapp", handle: "15550000001", displayName: "Me" },
};

function event(partial: Partial<MatrixEvent>): MatrixEvent {
  return { event_id: "$e", room_id: "!r", type: "m.room.message", sender: "@x:bridge.local", origin_server_ts: 0, content: {}, ...partial };
}

const state = [
  event({ type: "m.room.create", state_key: "", origin_server_ts: 1000 }),
  event({
    type: "m.bridge",
    state_key: "net.maunium.whatsapp://whatsapp/123@g.us",
    content: { bridgebot: "@whatsappbot:bridge.local", protocol: { id: "whatsapp" }, channel: { id: "123@g.us" } },
  }),
  event({ type: "m.room.name", state_key: "", content: { name: "Climbing" } }),
  event({ type: "m.room.member", state_key: "@whatsappbot:bridge.local", content: { membership: "join" } }),
  event({ type: "m.room.member", state_key: owner.mxid, content: { membership: "join" } }),
  event({ type: "m.room.member", state_key: "@whatsapp_15550000001:bridge.local", content: { membership: "join", displayname: "Me" } }),
  event({ type: "m.room.member", state_key: "@whatsapp_15550000002:bridge.local", content: { membership: "join", displayname: "Alice" } }),
  event({ type: "m.room.member", state_key: "@whatsapp_15550000003:bridge.local", content: { membership: "leave" } }),
];

test("unescapes mautrix localparts", () => {
  assert.equal(unescapeLocalpart("lid-123"), "lid-123");
  assert.equal(unescapeLocalpart("_abc=40x"), "Abc@x");
});

test("rooms without bridge info are not conversations", () => {
  assert.equal(roomFromState("!r", "acc1", state.filter((e) => e.type !== "m.bridge"), [bridge]), undefined);
});

test("a group portal becomes a titled conversation without the owner, the bot or the owner's ghost", () => {
  const room = roomFromState("!r", "acc1", state, [bridge])!;
  assert.deepEqual(toConversation(room, bridge, owner), {
    id: "whatsapp:123@g.us",
    platform: "whatsapp",
    participants: [{ id: "whatsapp:15550000002", platform: "whatsapp", handle: "15550000002", displayName: "Alice" }],
    title: "Climbing",
    lastMessage: undefined,
    updatedAt: new Date(1000).toISOString(),
  });
});

test("maps messages, captions, edits and own messages", () => {
  const room = roomFromState("!r", "acc1", state, [bridge])!;
  const text = toMessage(
    event({ event_id: "$1", sender: "@whatsapp_15550000002:bridge.local", origin_server_ts: 5000, content: { msgtype: "m.text", body: "hi" } }),
    room,
    bridge,
    owner,
  )!;
  assert.deepEqual(text, {
    id: "whatsapp:$1",
    conversationId: "whatsapp:123@g.us",
    sender: { id: "whatsapp:15550000002", platform: "whatsapp", handle: "15550000002", displayName: "Alice" },
    isMine: false,
    sentAt: new Date(5000).toISOString(),
    text: "hi",
    media: [],
  });

  const photo = toMessage(event({ content: { msgtype: "m.image", body: "photo.jpg", filename: "photo.jpg" } }), room, bridge, owner)!;
  assert.equal(photo.text, "[photo]");
  const captioned = toMessage(event({ content: { msgtype: "m.image", body: "look", filename: "photo.jpg" } }), room, bridge, owner)!;
  assert.equal(captioned.text, "look");

  const edit = toMessage(
    event({
      event_id: "$2",
      sender: "@whatsapp_15550000002:bridge.local",
      origin_server_ts: 9000,
      content: {
        body: "* hello",
        "m.new_content": { msgtype: "m.text", body: "hello" },
        "m.relates_to": { rel_type: "m.replace", event_id: "$1" },
      },
    }),
    room,
    bridge,
    owner,
    text,
  )!;
  assert.deepEqual(edit, { ...text, text: "hello" });

  const fromPhone = toMessage(event({ sender: "@whatsapp_15550000001:bridge.local", content: { msgtype: "m.text", body: "x" } }), room, bridge, owner)!;
  assert.equal(fromPhone.isMine, true);
  const doublePuppeted = toMessage(event({ sender: owner.mxid, content: { msgtype: "m.text", body: "x" } }), room, bridge, owner)!;
  assert.deepEqual([doublePuppeted.isMine, doublePuppeted.sender], [true, owner.me]);

  assert.equal(toMessage(event({ sender: "@whatsappbot:bridge.local", content: { msgtype: "m.notice", body: "x" } }), room, bridge, owner), undefined);
  assert.equal(toMessage(event({ type: "m.reaction" }), room, bridge, owner), undefined);
});
