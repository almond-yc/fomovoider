import { describe, expect, it } from "vitest";
import { ConnectorFailure } from "../../../types";
import { MemoryUsageStore } from "../../budget";
import { MockX, NOW, ME_ID, oauthSession, testConfig } from "../../__tests__/helpers";
import { XChatClient } from "../client";
import { chatConversationId, chatTarget, eventSortKey, snowflakeTime } from "../ids";
import { realmTokenFrom } from "../juicebox";
import conversationsFixture from "../fixtures/chat-conversations.json";
import eventsFixture from "../fixtures/chat-events.json";
import keysMe from "../fixtures/chat-public-keys-me.json";
import keysAlice from "../fixtures/chat-public-keys-alice.json";
import sendFixture from "../fixtures/chat-send.json";

const ALICE = "1234567890";
const BOB = "987654321";
const ONE_TO_ONE = `x:${ALICE}-${ME_ID}`;
const clone = <T>(v: T): T => structuredClone(v);

function setup(config: Partial<typeof testConfig> = {}) {
  const x = new MockX();
  const usage = new MemoryUsageStore();
  const client = new XChatClient({ config: { ...testConfig, ...config }, fetch: x.fetch, now: () => NOW, sleep: async () => undefined, usage });
  return { x, usage, client, session: oauthSession() };
}

describe("X Chat ids", () => {
  it("shares the legacy DM id for a 1:1 and keeps group ids", () => {
    expect(chatConversationId(`${ME_ID}-${ALICE}`)).toBe(ONE_TO_ONE);
    expect(chatConversationId(`${ALICE}-${ME_ID}`)).toBe(ONE_TO_ONE);
    expect(chatConversationId("g1987000000000000000")).toBe("x:g1987000000000000000");
    expect(() => chatConversationId("1001:2002")).toThrow(ConnectorFailure);
  });

  it("targets the other person for a 1:1 and refuses someone else's chat", () => {
    expect(chatTarget(ONE_TO_ONE, ME_ID)).toBe(ALICE);
    expect(chatTarget("x:g1987000000000000000", ME_ID)).toBe("g1987000000000000000");
    expect(() => chatTarget(`x:${ALICE}-${BOB}`, ME_ID)).toThrow(/not one of this account's chats/);
  });

  it("reads snowflake times and sorts ids numerically as strings", () => {
    expect(new Date(snowflakeTime("2122034395345846272")!).toISOString()).toBe("2026-11-15T18:30:00.000Z");
    expect(snowflakeTime("abc")).toBeUndefined();
    expect(eventSortKey("99") < eventSortKey("100")).toBe(true);
  });

  it("finds realm tokens in the Juicebox config, nested JSON included", () => {
    expect(realmTokenFrom(keysMe.data[0]!.juicebox_config, "0102")).toBe("realm-token-old");
    expect(realmTokenFrom(JSON.stringify(keysMe.data[1]!.juicebox_config), "0a0b")).toBe("realm-token-a");
    expect(realmTokenFrom({ token_map: {} }, "0102")).toBeUndefined();
  });
});

describe("XChatClient.conversations", () => {
  it("lists conversations as locked rows with participants and no content", async () => {
    const { x, client, session } = setup();
    x.on("GET", "/2/chat/conversations", { body: clone(conversationsFixture) });
    const res = await client.conversations(session, { meId: ME_ID, since: "2026-11-14T00:00:00.000Z", limit: 20 });

    const call = x.callsTo("/2/chat/conversations")[0]!;
    expect(call.url.searchParams.get("start_time")).toBe("2026-11-14T00:00:00.000Z");
    expect(call.url.searchParams.get("expansions")).toBe("participant_ids,member_ids");
    expect(res.caughtUp).toBe(true);
    expect(res.newestAt).toBe("2026-11-15T18:30:00.000Z");
    expect(res.conversations).toEqual([
      {
        id: ONE_TO_ONE,
        platform: "x",
        participants: [{ id: `x:${ALICE}`, platform: "x", handle: "alice", displayName: "Alice", avatarUrl: "https://pbs.twimg.com/profile_images/1/alice.jpg", profileUrl: "https://x.com/alice" }],
        unavailable: { reason: "locked" },
        updatedAt: "2026-11-15T18:30:00.000Z",
      },
      expect.objectContaining({ id: "x:g1987000000000000000", unavailable: { reason: "locked" }, participants: [expect.objectContaining({ handle: "alice" }), expect.objectContaining({ handle: "bob" })] }),
    ]);
    expect(res.conversations[1]!.title).toBeUndefined();
    expect(res.conversations[1]!.lastMessage).toBeUndefined();
  });

  it("charges only the conversations returned against the daily chat budget", async () => {
    const { x, client, session } = setup({ dailyChatEventReadBudget: 4 });
    x.on("GET", "/2/chat/conversations", { body: clone(conversationsFixture) });
    await client.conversations(session, { meId: ME_ID, limit: 20 });
    expect(x.callsTo("/2/chat/conversations")[0]!.url.searchParams.get("max_results")).toBe("4");
    await client.conversations(session, { meId: ME_ID, limit: 20 });
    await expect(client.conversations(session, { meId: ME_ID, limit: 20 })).rejects.toMatchObject({ error: { kind: "budget_exhausted" } });
  });
});

describe("XChatClient.events", () => {
  it("returns ciphertext newest first and stops at the newest stored event", async () => {
    const { x, client, session } = setup();
    x.on("GET", `/2/chat/conversations/${ALICE}/events`, { body: clone(eventsFixture) });
    const res = await client.events(session, ONE_TO_ONE, { meId: ME_ID, afterId: "2122032382079926272", limit: 10 });

    expect(x.callsTo(`/2/chat/conversations/${ALICE}/events`)).toHaveLength(1);
    expect(res.caughtUp).toBe(true);
    expect(res.keyEvents).toEqual(["S0VZLUNIQU5HRS0x"]);
    expect(res.events).toEqual([
      { id: "2122034395345846272", encodedEvent: "RVZFTlQtMw==", keyVersion: "1794779680989", senderId: ALICE, createdAt: "2026-11-15T18:30:00.000Z" },
      { id: "2122033388712886272", encodedEvent: "RVZFTlQtMg==", keyVersion: "1794779680989", senderId: ME_ID, createdAt: "2026-11-15T18:26:00.000Z" },
    ]);
  });

  it("pages until the grant is spent and releases what it didn't use", async () => {
    const { x, client, session } = setup({ dailyChatEventReadBudget: 4 });
    const second = clone(eventsFixture);
    second.data = [{ id: "2122026845598646272", encoded_event: "RVZFTlQtMA==", created_at: "2026-11-15T18:00:00.000Z", sender_id: ALICE }];
    second.meta = { conversation_key_events: ["S0VZLUNIQU5HRS0x"], result_count: 1, has_more: false } as typeof second.meta;
    x.on("GET", `/2/chat/conversations/${ALICE}/events`, { body: clone(eventsFixture) }, { body: second });
    const res = await client.events(session, ONE_TO_ONE, { meId: ME_ID, limit: 10 });

    const calls = x.callsTo(`/2/chat/conversations/${ALICE}/events`);
    expect(calls.map((c) => c.url.searchParams.get("max_results"))).toEqual(["4", "1"]);
    expect(calls[1]!.url.searchParams.get("pagination_token")).toBe("page-2");
    expect(res.events.map((e) => e.id)).toEqual(["2122034395345846272", "2122033388712886272", "2122032382079926272", "2122026845598646272"]);
    expect(res.keyEvents).toEqual(["S0VZLUNIQU5HRS0x"]);
    expect(res.caughtUp).toBe(true);
    await expect(client.events(session, ONE_TO_ONE, { meId: ME_ID, limit: 10 })).rejects.toMatchObject({ error: { kind: "budget_exhausted" } });
  });
});

describe("XChatClient.keyContext", () => {
  it("returns the newest own key record with its Juicebox config and everyone's signing keys", async () => {
    const { x, client, session } = setup();
    x.on("GET", `/2/users/${ME_ID}/public_keys`, { body: clone(keysMe) });
    x.on("GET", `/2/users/${ALICE}/public_keys`, { body: clone(keysAlice) });
    const ctx = await client.keyContext(session, { meId: ME_ID, participantIds: [ALICE, ME_ID] });

    expect(x.calls).toHaveLength(2);
    expect(ctx.meId).toBe(ME_ID);
    expect(ctx.signingKeyVersion).toBe("1790000000000");
    expect(JSON.parse(ctx.juiceboxConfig!)).toEqual(keysMe.data[1]!.juicebox_config);
    expect(ctx.signingKeys).toContainEqual({
      userId: ALICE,
      publicKeyVersion: "1780000000000",
      publicKey: "QUxJQ0UtU0lH",
      identityPublicKey: "QUxJQ0UtSUQ=",
      identityPublicKeySignature: "QUxJQ0UtQklORA==",
    });
    expect(ctx.signingKeys).toHaveLength(3);
  });

  it("reports an account without X Chat keys as not set up", async () => {
    const { x, client, session } = setup();
    x.on("GET", `/2/users/${ME_ID}/public_keys`, { body: { data: [] } });
    expect(await client.keyContext(session, { meId: ME_ID, participantIds: [] })).toEqual({ meId: ME_ID, signingKeyVersion: null, juiceboxConfig: null, signingKeys: [] });
  });
});

describe("XChatClient.send", () => {
  const payload = { messageId: "76c05dc0-043f-419b-82ad-7425cb7bfb7b", encodedMessageCreateEvent: "Q1JFQVRF", encodedMessageEventSignature: "U0lH", xdkVersion: "0.7.3" };

  it("posts the device's ciphertext and nothing else", async () => {
    const { x, client, session } = setup();
    x.on("POST", `/2/chat/conversations/${ALICE}/messages`, { status: 201, body: clone(sendFixture) });
    expect(await client.send(session, ONE_TO_ONE, { meId: ME_ID, payload })).toEqual({ encodedMessageEvent: "U0VOVC1FVkVOVA==" });
    expect(JSON.parse(x.calls[0]!.body!)).toEqual({
      message_id: payload.messageId,
      encoded_message_create_event: "Q1JFQVRF",
      encoded_message_event_signature: "U0lH",
      xdk_version: "0.7.3",
    });
  });

  it("refuses an unencrypted payload before calling X", async () => {
    const { x, client, session } = setup();
    await expect(client.send(session, ONE_TO_ONE, { meId: ME_ID, payload: { ...payload, encodedMessageCreateEvent: "" } })).rejects.toThrow(/encrypted on the device/);
    expect(x.calls).toHaveLength(0);
  });

  it("explains X's refusals and gives the write back", async () => {
    const { x, client, session } = setup({ dailyWriteBudget: 1 });
    x.on(
      "POST",
      `/2/chat/conversations/${ALICE}/messages`,
      { status: 403, body: { type: "https://api.x.com/2/problems/recipient-not-messageable", title: "Forbidden", detail: "closed inbox" } },
      { status: 201, body: clone(sendFixture) },
    );
    await expect(client.send(session, ONE_TO_ONE, { meId: ME_ID, payload })).rejects.toThrow(/closed inbox or a block/);
    await expect(client.send(session, ONE_TO_ONE, { meId: ME_ID, payload })).resolves.toBeDefined();
  });
});
