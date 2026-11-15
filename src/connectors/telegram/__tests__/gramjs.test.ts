// @vitest-environment node
import bigInt from "big-integer";
import { Api } from "telegram";
import { describe, expect, it } from "vitest";
import { fromApi, toApi } from "../gramjs";

// The GramJS adapter's conversions, offline: plain-JSON TL in, serializable
// GramJS requests out, and GramJS results back to plain JSON.
describe("GramJS transport conversions", () => {
  it("builds serializable requests from plain TL, with longs as strings", () => {
    const req = toApi({
      _: "messages.getHistory",
      peer: { _: "inputPeerUser", userId: "5000000002", accessHash: "-9100000000000000002" },
      offsetId: 0,
      offsetDate: 0,
      addOffset: 0,
      limit: 20,
      maxId: 0,
      minId: 0,
      hash: "0",
    }) as Api.messages.GetHistory;
    expect(req).toBeInstanceOf(Api.messages.GetHistory);
    expect(req.peer).toBeInstanceOf(Api.InputPeerUser);
    expect(req.getBytes().length).toBeGreaterThan(40);

    const token = toApi({ _: "auth.importLoginToken", token: new Uint8Array([1, 2, 3]) }) as Api.auth.ImportLoginToken;
    expect(Buffer.isBuffer(token.token)).toBe(true);
    expect(token.getBytes().length).toBe(8);

    const send = toApi({ _: "messages.sendMessage", peer: { _: "inputPeerChat", chatId: "4000001" }, message: "hi" }) as Api.messages.SendMessage;
    expect(send.randomId).toBeDefined();
    expect(() => send.getBytes()).not.toThrow();
  });

  it("rejects unknown TL names", () => {
    expect(() => toApi({ _: "messages.nope" })).toThrow("Unknown TL name messages.nope");
  });

  it("turns results into plain TL", () => {
    const user = new Api.User({
      id: bigInt("5000000002"),
      accessHash: bigInt("-91"),
      firstName: "Bob",
      usernames: [new Api.Username({ username: "bobby", active: true })],
    } as any);
    const res = fromApi(
      new Api.messages.Dialogs({
        dialogs: [],
        messages: [new Api.Message({ id: 5, peerId: new Api.PeerUser({ userId: bigInt(7) }), date: 1, message: "x" } as any)],
        chats: [],
        users: [user],
      }),
    );
    expect(res._).toBe("messages.dialogs");
    expect(res.users[0]).toMatchObject({ _: "user", id: "5000000002", accessHash: "-91", firstName: "Bob", usernames: [{ _: "username", username: "bobby", active: true }] });
    expect(res.messages[0]).toMatchObject({ _: "message", id: 5, peerId: { _: "peerUser", userId: "7" }, date: 1, message: "x" });
    expect(Object.keys(res.users[0])).not.toContain("CONSTRUCTOR_ID");
  });
});
