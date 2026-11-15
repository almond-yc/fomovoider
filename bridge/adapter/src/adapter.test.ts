import assert from "node:assert/strict";
import { test } from "node:test";
import { Adapter, HttpError } from "./adapter.js";
import type { BridgeConfig, LoginStep, Provisioning } from "./bridges.js";
import type { BridgeEvent, ConvexPush } from "./convex.js";
import { MatrixError, type Matrix, type MatrixEvent } from "./matrix.js";
import { StateFile } from "./state.js";

const bridge: BridgeConfig = {
  platform: "whatsapp",
  url: "http://whatsapp",
  asToken: "as",
  provisioningSecret: "secret",
  ghostPrefix: "whatsapp_",
  protocols: ["whatsapp"],
};
const OWNER = "@fv_acc1:bridge.local";
const ALICE = "@whatsapp_15550000002:bridge.local";

function ev(partial: Partial<MatrixEvent>): MatrixEvent {
  return { event_id: "$e", room_id: "!dm", type: "m.room.message", sender: ALICE, origin_server_ts: 0, content: {}, ...partial };
}

const portalState = [
  ev({ type: "m.room.create", state_key: "", origin_server_ts: 1 }),
  ev({
    type: "m.bridge",
    state_key: "x",
    content: { bridgebot: "@whatsappbot:bridge.local", protocol: { id: "whatsapp" }, channel: { id: "15550000002@s.whatsapp.net" }, "com.beeper.room_type": "dm" },
  }),
  ev({ type: "m.room.member", state_key: OWNER, content: { membership: "join" } }),
  ev({ type: "m.room.member", state_key: ALICE, content: { membership: "join", displayname: "Alice" } }),
];

function setup(steps: LoginStep[] = []) {
  const pushed: BridgeEvent[] = [];
  const synced: { conversation?: any; message?: any }[] = [];
  const calls: string[] = [];
  const history: MatrixEvent[] = [];
  const matrix = {
    ensureUser: async (localpart: string) => void calls.push(`register ${localpart}`),
    join: async (roomId: string) => void calls.push(`join ${roomId}`),
    joinedRooms: async () => ["!dm"],
    roomState: async (roomId: string) => {
      if (roomId !== "!dm") throw new MatrixError(403, "M_FORBIDDEN", "not in room");
      return portalState;
    },
    lastEvents: async () => [...history].reverse(),
    sendMessage: async (_roomId: string, _user: string, _txn: string, content: any) => {
      calls.push(`send ${content.body}`);
      return "$sent";
    },
    readReceipt: async (_roomId: string, _user: string, eventId: string) => void calls.push(`read ${eventId}`),
  } as unknown as Matrix;
  const queue = [...steps];
  const provisioning = {
    logins: async () => ["old-login"],
    logout: async (_user: string, loginId: string) => void calls.push(`logout ${loginId}`),
    start: async (_user: string, flow: string) => {
      calls.push(`start ${flow}`);
      return queue.shift()!;
    },
    submitInput: async (_user: string, _step: LoginStep, fields: Record<string, string>) => {
      calls.push(`input ${JSON.stringify(fields)}`);
      return queue.shift()!;
    },
    wait: async () => {
      const next = queue.shift();
      if (!next) return new Promise<never>(() => {});
      return next;
    },
    whoami: async () => [{ id: "15550000001", profile: { name: "Me", phone: "+15550000001" } }],
  } as unknown as Provisioning;
  const convex = {
    send: async (event: BridgeEvent) => void pushed.push(event),
    sync: (_accountId: string, update: any) => void synced.push(update),
  } as unknown as ConvexPush;
  const state = new StateFile();
  const adapter = new Adapter({
    serverName: "bridge.local",
    bridges: [bridge],
    matrix,
    provisioning: new Map([["whatsapp", provisioning]]),
    convex,
    state,
    sendTimeoutMs: 50,
  });
  return { adapter, pushed, synced, calls, state, history };
}

const qr = (data: string): LoginStep => ({ login_id: "l", step_id: "qr", type: "display_and_wait", display_and_wait: { type: "qr", data } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("QR login: replaces old logins, returns the first code, pushes refreshes and the identity", async () => {
  const { adapter, pushed, calls, state } = setup([qr("qr-1"), qr("qr-2"), { login_id: "l", step_id: "done", type: "complete", complete: { user_login_id: "15550000001" } }]);
  assert.deepEqual(await adapter.login("acc1", "whatsapp", "qr"), { flow: "qr", code: "qr-1" });
  await settle();
  assert.deepEqual(calls, ["register fv_acc1", "logout old-login", "start qr"]);
  const me = { id: "whatsapp:15550000001", platform: "whatsapp", handle: "+15550000001", displayName: "Me" };
  assert.deepEqual(pushed, [
    { accountId: "acc1", kind: "pairing", flow: "qr", code: "qr-2" },
    { accountId: "acc1", kind: "connected", me },
  ]);
  assert.deepEqual(state.accounts.acc1, { platform: "whatsapp", loginId: "15550000001", me });
});

test("phone login submits the number and returns the pairing code", async () => {
  const { adapter, calls } = setup([
    { login_id: "l", step_id: "phone", type: "user_input", user_input: { fields: [{ type: "phone_number", id: "phone_number", name: "Phone" }] } },
    { login_id: "l", step_id: "code", type: "display_and_wait", display_and_wait: { type: "code", data: "ABCD-EFGH" } },
  ]);
  assert.deepEqual(await adapter.login("acc1", "whatsapp", "phone", "+15550000001"), { flow: "code", code: "ABCD-EFGH" });
  assert.ok(calls.includes('input {"phone_number":"+15550000001"}'));
  await assert.rejects(setup([portalState as never]).adapter.login("acc1", "whatsapp", "phone"), HttpError);
});

test("a failed login is reported to Convex", async () => {
  const { adapter, pushed } = setup([qr("qr-1"), { login_id: "l", step_id: "x", type: "cookies" }]);
  await adapter.login("acc1", "whatsapp", "qr");
  await settle();
  assert.deepEqual(pushed, [{ accountId: "acc1", kind: "failed", error: "Unexpected login step cookies" }]);
});

test("an invite joins the portal, catches up on history, then ingests live messages and edits", async () => {
  const { adapter, synced, calls, state, history } = setup();
  state.accounts.acc1 = { platform: "whatsapp", loginId: "15550000001" };
  history.push(ev({ event_id: "$old", origin_server_ts: 100, content: { msgtype: "m.text", body: "before join" } }));

  await adapter.handleTransaction("t1", [ev({ type: "m.room.member", state_key: OWNER, sender: "@whatsappbot:bridge.local", content: { membership: "invite" } })]);
  assert.ok(calls.includes("join !dm"));
  assert.deepEqual(synced.map((s) => s.message?.text), ["before join", undefined]);
  assert.equal(synced[1]!.conversation.participants[0].displayName, "Alice");

  await adapter.handleTransaction("t2", [
    ev({ event_id: "$live", origin_server_ts: 200, content: { msgtype: "m.text", body: "helo" } }),
    ev({ event_id: "$edit", origin_server_ts: 300, content: { body: "* hello", "m.new_content": { body: "hello" }, "m.relates_to": { rel_type: "m.replace", event_id: "$live" } } }),
  ]);
  const last = synced.at(-1)!;
  assert.deepEqual([last.message.id, last.message.text, last.message.sentAt], ["whatsapp:$live", "hello", new Date(200).toISOString()]);
  assert.equal(last.conversation.lastMessage.text, "hello");

  const before = synced.length;
  await adapter.handleTransaction("t2", [ev({ event_id: "$dup", content: { msgtype: "m.text", body: "replayed" } })]);
  assert.equal(synced.length, before);
});

test("send waits for the bridge's delivery status", async () => {
  const { adapter, calls, state } = setup();
  state.accounts.acc1 = { platform: "whatsapp", loginId: "15550000001" };
  const sending = adapter.send("acc1", "whatsapp:15550000002@s.whatsapp.net", "hi");
  await settle();
  await adapter.handleTransaction("t3", [
    ev({ type: "com.beeper.message_send_status", sender: "@whatsappbot:bridge.local", content: { status: "SUCCESS", "m.relates_to": { rel_type: "m.reference", event_id: "$sent" } } }),
  ]);
  const message = await sending;
  assert.deepEqual([message.id, message.isMine, message.text], ["whatsapp:$sent", true, "hi"]);
  assert.ok(calls.includes("send hi"));

  await adapter.handleTransaction("t5", [ev({ event_id: "$reply", origin_server_ts: 500, content: { msgtype: "m.text", body: "yo" } })]);
  await adapter.markRead("acc1", "whatsapp:15550000002@s.whatsapp.net");
  assert.equal(calls.at(-1), "read $reply");
});

test("a send the platform refuses throws, and unpaired accounts can't send", async () => {
  const { adapter, state } = setup();
  await assert.rejects(adapter.send("acc1", "whatsapp:x", "hi"), /not connected/);
  state.accounts.acc1 = { platform: "whatsapp", loginId: "15550000001" };
  const sending = adapter.send("acc1", "whatsapp:15550000002@s.whatsapp.net", "hi");
  await settle();
  await adapter.handleTransaction("t4", [
    ev({ type: "com.beeper.message_send_status", content: { status: "FAIL", message: "not on WhatsApp", "m.relates_to": { event_id: "$sent" } } }),
  ]);
  await assert.rejects(sending, /not on WhatsApp/);
  await assert.rejects(adapter.send("acc1", "whatsapp:unknown", "hi"), (error: HttpError) => error.status === 404);
});

test("only the current login's logout expires the account", async () => {
  const { adapter, pushed, state } = setup();
  state.accounts.acc1 = { platform: "whatsapp", loginId: "15550000001" };
  await adapter.handleBridgeStatus("whatsapp", { remoteState: { old: { state_event: "LOGGED_OUT", user_id: OWNER, remote_id: "old" } } });
  assert.deepEqual(pushed, []);
  await adapter.handleBridgeStatus("whatsapp", { state_event: "BAD_CREDENTIALS", user_id: OWNER, remote_id: "15550000001", error: "wa-logged-out" });
  assert.deepEqual(pushed, [{ accountId: "acc1", kind: "logged_out", reason: "wa-logged-out" }]);
  assert.equal(state.accounts.acc1!.loginId, undefined);
});
