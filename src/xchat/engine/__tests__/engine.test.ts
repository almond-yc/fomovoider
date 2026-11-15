/// <reference types="node" />
import https from "node:https";
import { createChat } from "@xdevplatform/chat-xdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Conversation, Person } from "../../../connectors/types";
import { type ChatEventRow, type ChatKeyContext, UNDECRYPTABLE_TEXT, chatMessages, unlockedConversation } from "../../../connectors/x/chat";
import { EngineError, type XdkChat, XChatEngine } from "../core";

const ME = "2244994945";
const ALICE = "1234567890";
const CONVERSATION = `x:${ALICE}-${ME}`;
const alice: Person = { id: `x:${ALICE}`, platform: "x", handle: "alice", displayName: "Alice" };
const me: Person = { id: `x:${ME}`, platform: "x", handle: "me", displayName: "Me" };
const people = new Map([
  [ALICE, alice],
  [ME, me],
]);

// The Chat XDK reads X's feature switches over https in the background; tests
// make no network calls.
const realGet = https.get;
beforeAll(() => {
  https.get = (() => {
    throw new Error("Live network access is not allowed in tests");
  }) as typeof https.get;
});
afterAll(() => {
  https.get = realGet;
});

const context: ChatKeyContext = { meId: ME, signingKeyVersion: "1", juiceboxConfig: '{"token_map":{"0a":"t"}}', signingKeys: [] };

function stubChat(overrides: Partial<XdkChat> = {}) {
  const calls: string[] = [];
  let seenPin: Uint8Array | undefined;
  const chat: XdkChat = {
    unlock: async (pin) => {
      seenPin = pin;
      calls.push(`unlock:${new TextDecoder().decode(pin)}`);
    },
    setIdentity: (p) => calls.push(`identity:${p.userId}:${p.signingKeyVersion}`),
    setSigningKeys: (k) => calls.push(`keys:${k.length}`),
    setCacheKeys: (on) => calls.push(`cache:${on}`),
    decryptEvents: () => ({ events: [], errors: {} }),
    encryptMessage: () => ({ messageId: "m", encodedMessageCreateEvent: "c", encodedMessageEventSignature: "s" }),
    lock: () => calls.push("lock"),
    free: () => calls.push("free"),
    ...overrides,
  };
  return { chat, calls, pin: () => seenPin };
}

describe("XChatEngine", () => {
  it("unlocks with the passcode, sets the identity and wipes the passcode bytes", async () => {
    const { chat, calls, pin } = stubChat();
    let tokenFor: string | undefined;
    const engine = new XChatEngine(async ({ getAuthToken }) => {
      tokenFor = await getAuthToken("0A");
      return chat;
    });
    await engine.unlock("2580", context);
    expect(tokenFor).toBe("t");
    expect(calls).toEqual(["unlock:2580", `identity:${ME}:1`, "keys:0", "cache:true"]);
    expect([...pin()!]).toEqual([0, 0, 0, 0]);
    expect(engine.unlocked).toBe(true);
    engine.lock();
    expect(calls.slice(-2)).toEqual(["lock", "free"]);
    expect(() => engine.decrypt(CONVERSATION, [], [])).toThrow(EngineError);
  });

  it("reports a wrong passcode with the guesses X has left", async () => {
    const { chat } = stubChat({
      unlock: async () => {
        throw Object.assign(new Error("InvalidPin"), { kind: "invalidPin", guessesRemaining: 17 });
      },
    });
    const engine = new XChatEngine(async () => chat);
    await expect(engine.unlock("0000", context)).rejects.toMatchObject({ kind: "invalidPin", guessesRemaining: 17 });
    expect(engine.unlocked).toBe(false);
  });

  it("refuses to unlock an account that never set up X Chat", async () => {
    const engine = new XChatEngine(async () => stubChat().chat);
    await expect(engine.unlock("2580", { ...context, juiceboxConfig: null, signingKeyVersion: null })).rejects.toMatchObject({ kind: "notSetUp" });
  });

  it("decrypts key changes first and lines outcomes up with the stored rows", async () => {
    let batch: string[] = [];
    const { chat } = stubChat({
      decryptEvents: ({ events }) => {
        batch = events;
        return {
          events: [
            { event: { type: "keyChange", conversationId: `${ALICE}:${ME}` }, originalB64: "KEY" },
            { event: { type: "message", senderId: ALICE, content: { contentType: "text", text: "older" } }, originalB64: "E1" },
          ],
          errors: { "2": "bad signature" },
        };
      },
    });
    const engine = new XChatEngine(async () => chat);
    await engine.unlock("2580", context);
    const rows: ChatEventRow[] = [
      { id: "2", encodedEvent: "E2", keyVersion: "7" },
      { id: "1", encodedEvent: "E1", keyVersion: "7" },
    ];
    expect(engine.decrypt(CONVERSATION, rows, ["KEY"])).toEqual([
      { error: "bad signature" },
      { event: { type: "message", senderId: ALICE, createdAtMsec: null, content: { contentType: "text", text: "older" }, attachments: null } },
    ]);
    expect(batch).toEqual(["KEY", "E1", "E2"]);
    expect(engine.encrypt(CONVERSATION, "hi")).toEqual({ messageId: "m", encodedMessageCreateEvent: "c", encodedMessageEventSignature: "s" });
    expect(() => engine.encrypt("x:g1", "hi")).toThrow(/Open this chat once/);
  });
});

describe("real Chat XDK round trip", () => {
  it("decrypts what another X Chat user encrypted into contract Messages", async () => {
    const sender = await createChat();
    const receiver = await createChat();
    const senderKeys = sender.generateKeypairs().publicKey;
    const receiverKeys = receiver.generateKeypairs().publicKey;
    sender.setIdentity({ userId: ALICE, signingKeyVersion: "1" });
    receiver.setIdentity({ userId: ME, signingKeyVersion: "1" });

    const change = sender.prepareConversationKeyChange({
      publicKeys: [
        { userId: ALICE, identityPublicKey: senderKeys.publicKey, publicKeyVersion: "1" },
        { userId: ME, identityPublicKey: receiverKeys.publicKey, publicKeyVersion: "1" },
      ],
    });
    const sent = sender.encryptMessage({ conversationId: change.conversationId, text: "hola, ¿llegó?", conversationKey: change.conversationKey, conversationKeyVersion: change.conversationKeyVersion });
    expect(sent.encodedMessageCreateEvent).not.toContain("hola");

    const myCopy = change.conversationParticipantKeys.find((k) => k.userId === ME)!;
    const key = receiver.decryptConversationKey(myCopy.encryptedConversationKey);
    const signingKeys = [
      { userId: ALICE, publicKeyVersion: "1", publicKey: senderKeys.signingPublicKey, identityPublicKey: senderKeys.publicKey, identityPublicKeySignature: senderKeys.identityPublicKeySignature },
    ];
    const event = receiver.decryptEvent({ eventB64: sent.eventB64, conversationKeys: { [change.conversationKeyVersion]: key }, signingKeys });
    expect(event).toMatchObject({ type: "message", senderId: ALICE, verified: true, content: { contentType: "text", text: "hola, ¿llegó?" } });

    const rows: ChatEventRow[] = [
      { id: "2122034395345846272", encodedEvent: sent.eventB64, keyVersion: change.conversationKeyVersion, senderId: ALICE, createdAt: "2026-11-15T18:30:00.000Z" },
      { id: "2122033388712886272", encodedEvent: "garbage", keyVersion: change.conversationKeyVersion, senderId: ME, createdAt: "2026-11-15T18:26:00.000Z" },
    ];
    const messages = chatMessages(rows, [{ event }, { error: "Decryption failed" }], { conversationId: CONVERSATION, meId: ME, people });
    expect(messages).toEqual([
      { id: "x:2122034395345846272", conversationId: CONVERSATION, sender: alice, isMine: false, sentAt: "2026-11-15T18:30:00.000Z", text: "hola, ¿llegó?", media: [] },
      { id: "x:2122033388712886272", conversationId: CONVERSATION, sender: me, isMine: true, sentAt: "2026-11-15T18:26:00.000Z", text: UNDECRYPTABLE_TEXT, media: [] },
    ]);

    const locked: Conversation = { id: CONVERSATION, platform: "x", participants: [alice], unavailable: { reason: "locked" }, updatedAt: "2026-11-15T18:00:00.000Z" };
    expect(unlockedConversation(locked, messages)).toEqual({ id: CONVERSATION, platform: "x", participants: [alice], lastMessage: messages[0], updatedAt: "2026-11-15T18:30:00.000Z" });

    const wrong = await createChat();
    wrong.generateKeypairs();
    expect(() => wrong.decryptConversationKey(myCopy.encryptedConversationKey)).toThrow();
  });
});

describe("chatMessages", () => {
  it("skips receipts and reactions, applies edits and shows attachments", () => {
    const rows: ChatEventRow[] = [
      { id: "5", encodedEvent: "e5", createdAt: "2026-11-15T18:05:00.000Z" },
      { id: "4", encodedEvent: "e4", createdAt: "2026-11-15T18:04:00.000Z" },
      { id: "3", encodedEvent: "e3", createdAt: "2026-11-15T18:03:00.000Z" },
      { id: "2", encodedEvent: "e2", createdAt: "2026-11-15T18:02:00.000Z" },
      { id: "1", encodedEvent: "e1", createdAt: "2026-11-15T18:01:00.000Z" },
    ];
    const messages = chatMessages(
      rows,
      [
        { event: { type: "message", senderId: ME, content: { contentType: "edit", targetMessageSequenceId: "1", updatedText: "fixed" } } },
        { event: { type: "readReceipt", senderId: ALICE } },
        { event: { type: "message", senderId: ALICE, content: { contentType: "reaction" } } },
        { event: { type: "message", senderId: ALICE, content: { contentType: "text", text: "" }, attachments: [{}] } },
        { event: { type: "message", senderId: ME, content: { contentType: "text", text: "tpyo" } } },
      ],
      { conversationId: CONVERSATION, meId: ME, people },
    );
    expect(messages.map((m) => [m.id, m.text, m.isMine])).toEqual([
      ["x:2", "[Attachment]", false],
      ["x:1", "fixed", true],
    ]);
  });
});
