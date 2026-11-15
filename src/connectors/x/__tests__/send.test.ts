import { describe, expect, it } from "vitest";
import { NOW, fixture, setup } from "./helpers";

const DM_PATH = "/2/dm_conversations/1234567890-2244994945/messages";

describe("send (legacy DM)", () => {
  it("sends text and returns my normalized message", async () => {
    const { connector, x, session } = setup();
    x.on("POST", DM_PATH, { status: 201, body: fixture("create-dm") });
    const { raw: _raw, ...msg } = await connector.send(session, "x:1234567890-2244994945", { text: "See you Tuesday" });
    expect(JSON.parse(x.callsTo(DM_PATH)[0]!.body!)).toEqual({ text: "See you Tuesday" });
    expect(msg).toEqual({
      id: "x:1582838223305412700",
      conversationId: "x:1234567890-2244994945",
      sender: {
        id: "x:2244994945",
        platform: "x",
        handle: "XDevelopers",
        displayName: "X Developers",
        avatarUrl: "https://pbs.twimg.com/profile_images/1/xdev_normal.jpg",
        profileUrl: "https://x.com/XDevelopers",
      },
      isMine: true,
      sentAt: new Date(NOW).toISOString(),
      text: "See you Tuesday",
      media: [],
    });
  });

  it("refuses media as unsupported", async () => {
    const { connector, session } = setup();
    await expect(connector.send(session, "x:1-2", { text: "pic", media: [{ kind: "image", url: "file://a.jpg" }] })).rejects.toMatchObject({
      error: { kind: "unsupported", capability: "sendMedia" },
    });
  });

  it("explains a refused DM and an encrypted X Chat conversation", async () => {
    const { connector, x, session } = setup();
    x.on("POST", DM_PATH, { status: 403, body: fixture("error-dm-not-accepting") }, { status: 403, body: fixture("error-dm-encrypted") });
    await expect(connector.send(session, "x:1234567890-2244994945", { text: "hi" })).rejects.toMatchObject({
      error: { kind: "platform", message: "X refused the message: The recipient is not accepting Direct Messages from you." },
    });
    await expect(connector.send(session, "x:1234567890-2244994945", { text: "hi" })).rejects.toMatchObject({
      error: { kind: "platform", message: expect.stringContaining("encrypted X Chat") },
    });
  });

  it("rejects ids from other platforms", async () => {
    const { connector, session } = setup();
    await expect(connector.send(session, "instagram:123", { text: "hi" })).rejects.toMatchObject({ error: { kind: "platform" } });
  });
});

describe("reply (proposed contract addition, X: mentions only)", () => {
  it("replies to a post and returns the normalized reply", async () => {
    const { connector, x, session } = setup();
    x.on("POST", "/2/tweets", { status: 201, body: fixture("create-post") });
    const post = await connector.reply!(session, "x:1857000000000000007", { text: "Thanks, glad you like it!" });
    expect(JSON.parse(x.callsTo("/2/tweets")[0]!.body!)).toEqual({ text: "Thanks, glad you like it!", reply: { in_reply_to_tweet_id: "1857000000000000007" } });
    expect(post).toMatchObject({
      id: "x:1445880548472328192",
      author: { handle: "XDevelopers" },
      text: "Thanks, glad you like it!",
      permalink: "https://x.com/XDevelopers/status/1445880548472328192",
      replyTo: { id: "x:1857000000000000007" },
    });
  });

  it("explains X's summoned-reply rule when X refuses", async () => {
    const { connector, x, session } = setup();
    x.on("POST", "/2/tweets", { status: 403, body: fixture("error-reply-not-summoned") });
    const err = await connector.reply!(session, "x:999", { text: "hello" }).catch((e: any) => e);
    expect(err.error).toEqual({ kind: "platform", message: expect.stringContaining("only lets apps reply to posts that @mention you") });
    expect(err.cause).toMatchObject({ status: 403, problem: fixture("error-reply-not-summoned") });
  });

  it("refuses links unless allowed, because X bills them at $0.20", async () => {
    const { connector, x, session } = setup();
    x.on("POST", "/2/tweets", { status: 201, body: fixture("create-post") });
    await expect(connector.reply!(session, "x:1", { text: "see example.com" })).rejects.toMatchObject({ error: { kind: "platform" } });
    expect(x.callsTo("/2/tweets")).toHaveLength(0);
    const permissive = setup({ connector: { allowReplyUrls: true } });
    permissive.x.on("POST", "/2/tweets", { status: 201, body: fixture("create-post") });
    await permissive.connector.reply!(permissive.session, "x:1", { text: "see https://example.com" });
    expect(permissive.x.callsTo("/2/tweets")).toHaveLength(1);
  });
});
