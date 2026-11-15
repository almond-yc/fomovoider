import { describe, expect, it } from "vitest";
import type { Post } from "../../types";
import type { XTweet, XUrlEntity } from "../api-types";
import { XMapper } from "../mappers";
import { HOME, ME_ID, MENTIONS, fixture, setup } from "./helpers";

async function feedPosts(): Promise<Post[]> {
  const { connector, x, session } = setup({ connector: { feedExclude: [] } });
  const home = fixture("home-timeline");
  delete home.meta.next_token;
  x.on("GET", HOME, { body: home });
  x.on("GET", MENTIONS, { body: fixture("mentions") });
  const page = await connector.feed(session, { since: "2026-11-15T00:00:00.000Z", limit: 50 });
  return page.items;
}

const byId = (posts: Post[], id: string) => posts.find((p) => p.id === id)!;
const withoutRaw = (post: Post | undefined): unknown => {
  if (!post) return post;
  const { raw: _raw, quoted, ...rest } = post;
  return quoted ? { ...rest, quoted: withoutRaw(quoted) } : rest;
};

describe("post normalization", () => {
  it("returns every post newest first with x-namespaced ids", async () => {
    const posts = await feedPosts();
    expect(posts.map((p) => p.id)).toEqual([
      "x:1857000000000000007",
      "x:1857000000000000006",
      "x:1856000000000000001",
      "x:1857000000000000004",
      "x:1857000000000000003",
    ]);
    expect(posts.every((p) => p.platform === "x" && p.raw !== undefined)).toBe(true);
  });

  it("plain post with a photo: expands t.co, drops the media link, decodes entities", async () => {
    expect(withoutRaw(byId(await feedPosts(), "x:1857000000000000006"))).toEqual({
      id: "x:1857000000000000006",
      platform: "x",
      author: {
        id: "x:783214",
        platform: "x",
        handle: "X",
        displayName: "X",
        avatarUrl: "https://pbs.twimg.com/profile_images/2/x_normal.jpg",
        profileUrl: "https://x.com/X",
      },
      createdAt: "2026-11-15T18:06:00.000Z",
      text: "Shipping notes & changelog: https://example.dev/changelog",
      media: [{ kind: "image", url: "https://pbs.twimg.com/media/changelog.jpg", width: 1200, height: 675, altText: "Changelog screenshot" }],
      permalink: "https://x.com/X/status/1857000000000000006",
    });
  });

  it("repost: shows the original post with repostedBy and the repost time", async () => {
    expect(withoutRaw(byId(await feedPosts(), "x:1856000000000000001"))).toEqual({
      id: "x:1856000000000000001",
      platform: "x",
      author: { id: "x:6253282", platform: "x", handle: "API", displayName: "X API", profileUrl: "https://x.com/API" },
      createdAt: "2026-11-15T18:05:00.000Z",
      text: "New video walkthrough of the v2 endpoints",
      media: [],
      permalink: "https://x.com/API/status/1856000000000000001",
      repostedBy: { id: "x:1234567890", platform: "x", handle: "developer", displayName: "Dev Person", profileUrl: "https://x.com/developer" },
    });
  });

  it("quote: nests the quoted post one level deep and drops its link from the text", async () => {
    const post = byId(await feedPosts(), "x:1857000000000000004");
    expect(post.text).toBe("This is a great thread");
    expect(withoutRaw(post.quoted)).toEqual({
      id: "x:1856000000000000002",
      platform: "x",
      author: { id: "x:6253282", platform: "x", handle: "API", displayName: "X API", profileUrl: "https://x.com/API" },
      createdAt: "2026-11-14T12:00:00.000Z",
      text: "Thread: how we built v2 <3",
      media: [],
      permalink: "https://x.com/API/status/1856000000000000002",
    });
    expect(post.quoted?.quoted).toBeUndefined();
  });

  it("long post with a video: uses the full note text with its links expanded and the best MP4", async () => {
    const post = byId(await feedPosts(), "x:1857000000000000003");
    expect(post.text).toBe("Long post: the first 280 characters of a longer note, and then the rest of it, with a link https://docs.x.com/x-api at the end.");
    expect(post.media).toEqual([
      {
        kind: "video",
        url: "https://video.twimg.com/ext_tw_video/vid/1280x720/walkthrough.mp4",
        previewUrl: "https://pbs.twimg.com/ext_tw_video_thumb/walkthrough.jpg",
        width: 1280,
        height: 720,
        altText: "Walkthrough video",
        durationSec: 95.5,
      },
    ]);
  });

  it("mention that replies: replyTo with author, leading @handles stripped, gif media", async () => {
    const post = byId(await feedPosts(), "x:1857000000000000007");
    expect(post.text).toBe("love the new API!");
    expect(post.replyTo).toEqual({
      id: "x:1856000000000000003",
      author: {
        id: `x:${ME_ID}`,
        platform: "x",
        handle: "XDevelopers",
        displayName: "X Developers",
        avatarUrl: "https://pbs.twimg.com/profile_images/1/xdev_normal.jpg",
        profileUrl: "https://x.com/XDevelopers",
      },
    });
    expect(post.media).toEqual([
      { kind: "gif", url: "https://video.twimg.com/tweet_video/party.mp4", previewUrl: "https://pbs.twimg.com/tweet_video_thumb/party.jpg", width: 480, height: 270 },
    ]);
  });
});

describe("DM normalization", () => {
  it("derives conversations with participants, last message and updatedAt", async () => {
    const { connector, x, session } = setup();
    x.on("GET", "/2/dm_events", { body: fixture("dm-events") });
    const page = await connector.conversations(session, { limit: 50 });
    expect(page.caughtUp).toBe(false);
    expect(page.cursor).toBe("18LAA581J5II7LA00C00ZZZZ");
    const [direct, group, encrypted] = page.items;
    expect(encrypted).toMatchObject({ id: "x:555000555-2244994945", unavailable: { reason: "encrypted" } });
    expect(direct).toMatchObject({
      id: "x:1234567890-2244994945",
      platform: "x",
      participants: [{ id: "x:1234567890", handle: "developer", displayName: "Dev Person" }],
      updatedAt: "2026-11-15T19:02:00.000Z",
    });
    expect(direct).not.toHaveProperty("unreadCount");
    expect(direct).not.toHaveProperty("unavailable");
    const { raw: _raw, ...last } = direct!.lastMessage!;
    expect(last).toEqual({
      id: "x:1582838223305412612",
      conversationId: "x:1234567890-2244994945",
      sender: { id: "x:1234567890", platform: "x", handle: "developer", displayName: "Dev Person", profileUrl: "https://x.com/developer" },
      isMine: false,
      sentAt: "2026-11-15T19:02:00.000Z",
      text: "Sounds good, see you then https://maps.example.com/cafe",
      media: [],
    });
    expect(group).toMatchObject({ id: "x:1582103724607971328", updatedAt: "2026-11-15T18:00:00.000Z" });
    expect(group!.participants.map((p) => p.handle).sort()).toEqual(["X", "developer"]);
    expect(group!.lastMessage!.media).toEqual([{ kind: "image", url: "https://ton.twimg.com/dm/1582103724607971329/welcome.jpg", width: 800, height: 600 }]);
  });

  it("returns a conversation's messages newest first with isMine set", async () => {
    const { connector, x, session } = setup();
    const path = "/2/dm_conversations/1234567890-2244994945/dm_events";
    x.on("GET", path, { body: fixture("conversation-events") });
    const page = await connector.messages(session, "x:1234567890-2244994945", { limit: 20 });
    expect(x.callsTo(path)[0]!.url.searchParams.get("event_types")).toBe("MessageCreate");
    expect(page.items.map((m) => [m.id, m.isMine, m.text])).toEqual([
      ["x:1582838223305412612", false, "Sounds good, see you then https://maps.example.com/cafe"],
      ["x:1582838223305412611", true, "Want to grab coffee Tuesday?"],
    ]);
    expect(page).toMatchObject({ caughtUp: true, cursor: "" });
  });
});

describe("post title (contract v5)", () => {
  const users = [{ id: "7", username: "alice", name: "Alice Smith" }];
  const tweet = (extra: Partial<XTweet>): XTweet => ({ id: "1", text: "Read this https://t.co/a", author_id: "7", created_at: "2026-11-15T00:00:00.000Z", ...extra });
  const link = (extra: Partial<XUrlEntity> = {}): XUrlEntity => ({ url: "https://t.co/a", expanded_url: "https://example.com/a", ...extra });
  const map = (t: XTweet) => new XMapper({ users }).post(t);

  it("uses a link card's headline", () => {
    expect(map(tweet({ entities: { urls: [link({ title: "Why finite feeds win" })] } })).title).toBe("Why finite feeds win");
  });

  it("prefers an article's title", () => {
    expect(map(tweet({ article: { title: "My article" }, entities: { urls: [link({ title: "Card" })] } })).title).toBe("My article");
  });

  it("is unset without a real title, and never the author's name", () => {
    const post = map(tweet({ entities: { urls: [link()] } }));
    expect(post).not.toHaveProperty("title");
    expect(map(tweet({ entities: { urls: [link({ title: "Photo", media_key: "3_1", display_url: "pic.x.com/abc" })] } }))).not.toHaveProperty("title");
  });
});


describe("DM participants X didn't expand", () => {
  const myMessage = { data: [{ id: "1900000000000000001", event_type: "MessageCreate", text: "Hi Ethan!", sender_id: ME_ID, dm_conversation_id: `777-${ME_ID}`, created_at: "2026-10-20T05:29:28.000Z" }], includes: { users: [] }, meta: { result_count: 1 } };
  const ethan = { id: "777", username: "ethan", name: "Ethan F", profile_image_url: "https://pbs.twimg.com/ethan.jpg" };

  it("looks them up so the conversation has a handle and display name, billed as DM event reads", async () => {
    const { connector, x, session } = setup({ config: { dailyDmEventReadBudget: 10 } });
    x.on("GET", "/2/dm_events", { body: myMessage });
    x.on("GET", "/2/users", { body: { data: [ethan] } });
    const { conversations } = await connector.inbox(session, { limit: 5 });
    expect(conversations[0]!.participants).toEqual([expect.objectContaining({ id: "x:777", handle: "ethan", displayName: "Ethan F" })]);
    const lookup = x.callsTo("/2/users")[0]!;
    expect(lookup.url.searchParams.get("ids")).toBe("777");
    expect(lookup.url.searchParams.get("user.fields")).toContain("username");
    expect(await connector.remainingBudget(ME_ID, "dmEventReads")).toBe(8);
  });

  it("makes no lookup when X already expanded everyone", async () => {
    const { connector, x, session } = setup();
    x.on("GET", "/2/dm_events", { body: fixture("dm-events") });
    await connector.conversations(session, { limit: 50 });
    expect(x.callsTo("/2/users")).toHaveLength(0);
  });

  it("leaves them unnamed when the lookup fails, keeping the DM page", async () => {
    const { connector, x, session } = setup({ config: { dailyDmEventReadBudget: 10 } });
    x.on("GET", "/2/dm_events", { body: myMessage });
    x.on("GET", "/2/users", { status: 429, body: fixture("error-rate-limited"), headers: { "x-rate-limit-reset": "0" } });
    const { conversations, messages } = await connector.inbox(session, { limit: 5 });
    expect(conversations[0]!.participants[0]).toMatchObject({ id: "x:777" });
    expect(messages).toHaveLength(1);
    expect(await connector.remainingBudget(ME_ID, "dmEventReads")).toBe(9);
  });

  it("still fails on an expired session during the lookup", async () => {
    const { connector, x, session } = setup({ config: { dailyDmEventReadBudget: 10 } });
    x.on("GET", "/2/dm_events", { body: myMessage });
    x.on("GET", "/2/users", { status: 401, body: fixture("error-unauthorized") });
    x.on("POST", "/2/oauth2/token", { status: 400, body: fixture("token-invalid") });
    await expect(connector.inbox(session, { limit: 5 })).rejects.toMatchObject({ error: { kind: "session_expired" } });
  });

  it("leaves them unnamed when the DM budget is spent", async () => {
    const { connector, x, session } = setup({ config: { dailyDmEventReadBudget: 1 } });
    x.on("GET", "/2/dm_events", { body: myMessage });
    const { conversations } = await connector.inbox(session, { limit: 1 });
    expect(conversations[0]!.participants[0]).toMatchObject({ id: "x:777" });
    expect(x.callsTo("/2/users")).toHaveLength(0);
  });
});

