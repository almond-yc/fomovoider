import { describe, expect, test } from "vitest";
import feedPage from "./__fixtures__/feed-following-page.json";
import ssrScripts from "./__fixtures__/ssr-home-scripts.json";
import storiesPage from "./__fixtures__/stories-reels-media.json";
import { extract, parseResponseText, phoneSize, PHONE_IMAGE_WIDTH } from "./parse";

// Fixtures are redacted captures from the FOMO-23 spike (instagram.com in a
// WKWebView, 2026-11-15): every name, caption, id, URL and coordinate is
// replaced, and only the fields the parser reads are kept.

describe("feed parsing", () => {
  const parsed = extract(parseResponseText(JSON.stringify(feedPage)));

  test("every feed unit that is a post becomes a post; ads and suggestions are kept and marked", () => {
    expect(parsed.posts).toHaveLength(5);
    expect(parsed.nonPostUnits).toBe(1);
    const [carousel, reel, photo, ad, suggested] = parsed.posts;
    expect(carousel.facts).toMatchObject({ sponsored: false, suggested: false, isReel: false });
    expect(reel.facts.isReel).toBe(true);
    expect(photo.facts.sponsored).toBe(false);
    expect(ad.facts).toMatchObject({ sponsored: true, suggested: false });
    expect(suggested.facts).toMatchObject({ sponsored: false, suggested: true });
  });

  test("maps a carousel with a location onto the contract's Post", () => {
    const post = parsed.posts[0];
    expect(post.id).toMatch(/^instagram:\d+$/);
    expect(post.format).toBe("post");
    expect(post.author).toMatchObject({ platform: "instagram", id: "instagram:" + post.author.handle });
    expect(post.author.profileUrl).toBe(`https://www.instagram.com/${post.author.handle}/`);
    expect(post.permalink).toMatch(/^https:\/\/www\.instagram\.com\/p\/C\d+\/$/);
    expect(post.text).toContain("Example caption");
    expect(post.extracted?.place).toEqual({ name: "Example Place", lat: 37.5, lng: -122.25 });
    expect(new Date(post.createdAt).getFullYear()).toBe(2026);
    expect(post.media.length).toBeGreaterThan(1);
    expect(post.expiresAt).toBeUndefined();
    // A collab post whose author the viewer doesn't follow but a co-author they
    // do: organic, not a suggestion.
    expect(post.facts).toMatchObject({ followsAuthor: false, suggested: false });
    expect(post).not.toHaveProperty("title");
  });

  test("images are picked at phone quality, about 1080 px wide", () => {
    const widths = parsed.posts.flatMap((p) => p.media.filter((m) => m.kind === "image").map((m) => m.width!));
    expect(widths.length).toBeGreaterThan(0);
    // The largest candidate within 1080 px, or the smallest when none fits.
    for (const w of widths) expect(w).toBeLessThanOrEqual(1200);
    expect(Math.max(...widths)).toBeGreaterThanOrEqual(720);
  });

  test("a feed video's duration comes from its DASH manifest", () => {
    const doc = structuredClone(feedPage) as any;
    doc.data.xdt_api__v1__feed__timeline__connection.edges[1].node.media.video_dash_manifest =
      '<MPD mediaPresentationDuration="PT1M9.5S"></MPD>';
    expect(extract([doc]).posts[1].media[0].durationSec).toBe(69.5);
  });

  test("reels are videos with a phone-size poster to upload and a /reel/ permalink", () => {
    const reel = parsed.posts[1];
    expect(reel.permalink).toContain("/reel/");
    const [video] = reel.media;
    expect(video.kind).toBe("video");
    expect(video.previewUrl).toBeDefined();
    expect(video.upload.video).toBe(video.url);
    expect(video.upload.image).toBeDefined();
  });

  test("engagement counts never come out", () => {
    const text = JSON.stringify(parsed.posts);
    for (const key of ["like_count", "comment_count", "likes", "view_count", "play_count"]) {
      expect(text).not.toContain(key);
    }
  });

  test("reports the Following page cursor", () => {
    expect(parsed.feedPages).toEqual([{ variant: "following", endCursor: "KGkAcursorPage2==", hasNextPage: true }]);
  });
});

describe("server-rendered first page", () => {
  const parsed = extract((ssrScripts as string[]).flatMap(parseResponseText));

  test("reads the viewer, the story tray order and the home feed's first page", () => {
    expect(parsed.viewer).toMatchObject({ id: "instagram:viewer_me", handle: "viewer_me" });
    expect(parsed.tray.map((r) => r.position)).toEqual([1, 2, 3]);
    expect(parsed.tray[0].reelId).toMatch(/^\d+$/);
    expect(parsed.feedPages).toEqual([{ variant: "home", endCursor: "KGkAcursorHome1==", hasNextPage: true }]);
    expect(parsed.posts).toHaveLength(1);
    expect(parsed.nonPostUnits).toBe(1);
  });
});

describe("story parsing", () => {
  const docs = parseResponseText(JSON.stringify(storiesPage));
  const firstReel = (storiesPage as any).data.xdt_api__v1__feed__reels_media__connection.edges[0].node;

  test("story items become story posts that expire, with the tray position", () => {
    const parsed = extract(docs, new Map([[String(firstReel.id), 4]]));
    expect(parsed.posts).toHaveLength(2);
    const story = parsed.posts[0];
    expect(story.format).toBe("story");
    expect(story.author.handle).toBe(firstReel.user.username);
    expect(story.permalink).toBe(
      `https://www.instagram.com/stories/${firstReel.user.username}/${firstReel.items[0].pk}/`,
    );
    expect(story.expiresAt).toBe(new Date(firstReel.items[0].expiring_at * 1000).toISOString());
    expect(story.text).toMatch(/^@user_\d+$/);
    expect(story.facts).toMatchObject({ sponsored: false, storyTrayPosition: 4, followsAuthor: true });
    expect(parsed.posts[1].facts.storyTrayPosition).toBeUndefined();
    // The story's own media at phone quality, dated by taken_at.
    expect(story.media).toEqual([expect.objectContaining({ kind: "image", width: 828 })]);
    expect(story.media[0].url).toBe(firstReel.items[0].image_versions2.candidates[1].url);
    expect(story.media[0].upload.image).toBe(story.media[0].url);
    expect(story.createdAt).toBe(new Date(firstReel.items[0].taken_at * 1000).toISOString());
  });

  test("location, hashtag and link stickers become text and the place", () => {
    const doc = structuredClone(storiesPage) as any;
    const item = doc.data.xdt_api__v1__feed__reels_media__connection.edges[0].node.items[0];
    item.story_locations = [{ location: { pk: 1, name: "Dolores Park", lat: 37.76, lng: -122.43 } }];
    item.story_hashtags = [{ hashtag: { name: "sf" } }];
    item.story_link_stickers = [{ story_link: { url: "https://example.com/event", link_title: "Tickets" } }];
    item.video_versions = [{ url: "https://scontent.cdninstagram.com/v.mp4", width: 720, height: 1280 }];
    item.video_duration = 9.5;
    const [story] = extract([doc]).posts;
    expect(story.extracted?.place).toEqual({ name: "Dolores Park", lat: 37.76, lng: -122.43 });
    expect(story.text).toContain("#sf");
    expect(story.text).toContain("Dolores Park");
    expect(story.text).toContain("Tickets https://example.com/event");
    expect(story.media[0]).toMatchObject({ kind: "video", durationSec: 9.5, upload: { video: "https://scontent.cdninstagram.com/v.mp4" } });
  });
});

describe("helpers", () => {
  test("parseResponseText strips the anti-hijacking prefix and reads one document per line", () => {
    expect(parseResponseText('for (;;);{"a":1}')).toEqual([{ a: 1 }]);
    expect(parseResponseText('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parseResponseText("not json")).toEqual([]);
  });

  test("phoneSize picks the largest candidate within phone width", () => {
    const pick = phoneSize([
      { url: "a", width: 1440 },
      { url: "b", width: 1080 },
      { url: "c", width: 640 },
    ]);
    expect(pick?.url).toBe("b");
    expect(phoneSize([{ url: "big", width: 2000 }])?.url).toBe("big");
    expect(PHONE_IMAGE_WIDTH).toBe(1080);
  });
});
