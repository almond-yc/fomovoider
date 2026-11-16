// Parsers for the instagram.com responses the hidden web view captures
// passively: the home and Following feeds (GraphQL
// PolarisFeedRootPaginationCachedQuery and the server-rendered first page),
// the story tray (server-rendered) and story reels
// (PolarisStoriesV3ReelPageGalleryQuery). They map onto the contract's Post
// (v5) plus the facts Instagram showed about each item. Nothing is filtered:
// ads, suggestions and reels come out as posts with their facts set.
// Engagement counts are never read.

export type FeedVariant = "home" | "following";

export interface Person {
  id: string;
  platform: "instagram";
  handle: string;
  displayName: string;
  avatarUrl?: string;
  profileUrl: string;
}

export interface CapturedMedia {
  kind: "image" | "video";
  url: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  altText?: string;
  durationSec?: number;
  // What the phone uploads to Convex storage: a phone-size image (the
  // poster frame for a video), and the video file itself for videos.
  upload: { image?: string; video?: string };
}

export interface ItemFacts {
  sponsored: boolean;
  suggested: boolean;
  isReel: boolean;
  paidPartnership?: boolean;
  followsAuthor?: boolean;
  storyTrayPosition?: number;
}

export interface CapturedPost {
  id: string;
  author: Person;
  createdAt: string;
  text: string;
  permalink: string;
  format: "post" | "story";
  expiresAt?: string;
  extracted?: { place?: { name: string; lat?: number; lng?: number } };
  media: CapturedMedia[];
  facts: ItemFacts;
}

export interface FeedPage {
  variant: FeedVariant;
  endCursor: string | null;
  hasNextPage: boolean;
}

export interface TrayReel {
  reelId: string;
  handle?: string;
  position: number;
  latestReelMedia?: number;
  seen: boolean;
}

export interface ParsedCapture {
  posts: CapturedPost[];
  feedPages: FeedPage[];
  tray: TrayReel[];
  viewer?: Person;
  // Feed units that are not posts (people suggestions, end-of-feed markers),
  // counted so a run can report them.
  nonPostUnits: number;
  endOfFeed: boolean;
}

// The width the phone uploads: about a phone screen's pixels, so a feed
// image is ~100-250 KB instead of the multi-megabyte original.
export const PHONE_IMAGE_WIDTH = 1080;

const BASE = "https://www.instagram.com";

type Json = any;

// Instagram's ajax responses may start with an anti-hijacking prefix, and
// streamed GraphQL responses carry one JSON document per line.
export function parseResponseText(text: string): Json[] {
  const body = text.replace(/^\s*for \(;;\);/, "");
  try {
    return [JSON.parse(body)];
  } catch {
    const docs: Json[] = [];
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      try {
        docs.push(JSON.parse(line));
      } catch {
        // A truncated or non-JSON line carries nothing we read.
      }
    }
    return docs;
  }
}

function* findKey(value: Json, key: string): Generator<Json> {
  if (Array.isArray(value)) {
    for (const item of value) yield* findKey(item, key);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === key && v) yield v;
      yield* findKey(v, key);
    }
  }
}

function iso(seconds: number) {
  return new Date(seconds * 1000).toISOString();
}

export function person(user: Json): Person {
  const handle = String(user.username);
  return {
    id: "instagram:" + handle,
    platform: "instagram",
    handle,
    displayName: user.full_name || handle,
    ...(user.profile_pic_url ? { avatarUrl: user.profile_pic_url } : {}),
    profileUrl: BASE + "/" + handle + "/",
  };
}

type Candidate = { url: string; width?: number; height?: number };

// The largest candidate no wider than the phone width, else the smallest.
export function phoneSize(candidates: Candidate[]): Candidate | undefined {
  const sorted = [...candidates].filter((c) => c?.url).sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return sorted.find((c) => (c.width ?? 0) <= PHONE_IMAGE_WIDTH) ?? sorted[sorted.length - 1];
}

// A video's length: video_duration when set (stories), else the DASH
// manifest's mediaPresentationDuration (feed videos leave video_duration null).
function durationSec(item: Json): number | undefined {
  if (typeof item.video_duration === "number" && item.video_duration > 0) return item.video_duration;
  const m = /mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?([\d.]+)S"/.exec(String(item.video_dash_manifest ?? ""));
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3]);
}

// Media at phone quality (about 1080 px wide): the URL, size and uploaded
// file all describe the same candidate. Videos carry their poster frame.
function mediaOf(item: Json): CapturedMedia[] {
  if (Array.isArray(item.carousel_media) && item.carousel_media.length) {
    return item.carousel_media.flatMap(mediaOf);
  }
  const image = phoneSize(item.image_versions2?.candidates ?? []);
  const alt = item.accessibility_caption ? { altText: String(item.accessibility_caption) } : {};
  const video = phoneSize(item.video_versions ?? []);
  if (video) {
    const duration = durationSec(item);
    return [
      {
        kind: "video",
        url: video.url,
        ...(image ? { previewUrl: image.url } : {}),
        width: video.width ?? item.original_width,
        height: video.height ?? item.original_height,
        ...alt,
        ...(duration ? { durationSec: duration } : {}),
        upload: { image: image?.url, video: video.url },
      },
    ];
  }
  if (!image) return [];
  return [
    {
      kind: "image",
      url: image.url,
      width: image.width ?? item.original_width,
      height: image.height ?? item.original_height,
      ...alt,
      upload: { image: image.url },
    },
  ];
}

function place(location: Json) {
  if (!location?.name) return undefined;
  return {
    name: String(location.name),
    ...(typeof location.lat === "number" ? { lat: location.lat } : {}),
    ...(typeof location.lng === "number" ? { lng: location.lng } : {}),
  };
}

function feedPost(media: Json, unit: { sponsored: boolean; suggested: boolean }): CapturedPost | undefined {
  if (!media?.pk || !media.user?.username || !media.taken_at) return undefined;
  const isReel = media.product_type === "clips";
  const following = media.user.friendship_status?.following;
  // A collab post reaches the feed when the viewer follows any of its
  // authors, so it is only a suggestion when none of them is followed.
  const followsAnyAuthor =
    following === true || (media.coauthor_producers ?? []).some((c: Json) => c?.friendship_status?.following === true);
  const where = place(media.location);
  return {
    id: "instagram:" + media.pk,
    author: person(media.user),
    createdAt: iso(media.taken_at),
    text: media.caption?.text ?? "",
    permalink: media.code ? BASE + (isReel ? "/reel/" : "/p/") + media.code + "/" : person(media.user).profileUrl,
    format: "post",
    ...(where ? { extracted: { place: where } } : {}),
    media: mediaOf(media),
    facts: {
      sponsored: unit.sponsored || media.product_type === "ad",
      suggested: unit.suggested || (!unit.sponsored && following === false && !followsAnyAuthor),
      isReel,
      ...(media.is_paid_partnership ? { paidPartnership: true } : {}),
      ...(typeof following === "boolean" ? { followsAuthor: following } : {}),
    },
  };
}

function storyText(item: Json) {
  const parts: string[] = [];
  for (const s of item.story_bloks_stickers ?? []) {
    const mention = s?.bloks_sticker?.sticker_data?.ig_mention;
    if (mention?.username) parts.push("@" + mention.username);
  }
  for (const s of item.story_hashtags ?? []) if (s?.hashtag?.name) parts.push("#" + s.hashtag.name);
  for (const s of item.story_locations ?? []) if (s?.location?.name) parts.push(s.location.name);
  for (const s of item.story_link_stickers ?? []) {
    const link = s?.story_link;
    if (link?.url) parts.push(link.link_title ? link.link_title + " " + link.url : link.url);
  }
  if (item.caption?.text) parts.push(item.caption.text);
  return parts.join(" ");
}

function storyPost(reel: Json, item: Json, trayPosition: number | undefined): CapturedPost | undefined {
  const user = reel.user?.username ? reel.user : item.user;
  if (!item?.pk || !user?.username || !item.taken_at) return undefined;
  const following = reel.user?.friendship_status?.following;
  const where = place(item.story_locations?.[0]?.location);
  return {
    id: "instagram:" + item.pk,
    author: person(user),
    createdAt: iso(item.taken_at),
    text: storyText(item),
    permalink: BASE + "/stories/" + user.username + "/" + item.pk + "/",
    format: "story",
    expiresAt: iso(item.expiring_at ?? item.taken_at + 24 * 3600),
    ...(where ? { extracted: { place: where } } : {}),
    media: mediaOf(item),
    facts: {
      sponsored: Boolean(item.ad_id || reel.ad_id) || /ad/i.test(String(reel.reel_type ?? "")),
      suggested: false,
      isReel: false,
      ...(item.is_paid_partnership ? { paidPartnership: true } : {}),
      ...(typeof following === "boolean" ? { followsAuthor: following } : {}),
      ...(trayPosition !== undefined ? { storyTrayPosition: trayPosition } : {}),
    },
  };
}

// Reads every feed connection, tray, story reel and viewer found anywhere in
// the given documents. trayOrder maps a reel id (the author's pk) to its
// position in the tray seen earlier in the session.
export function extract(docs: Json[], trayOrder: Map<string, number> = new Map()): ParsedCapture {
  const out: ParsedCapture = { posts: [], feedPages: [], tray: [], nonPostUnits: 0, endOfFeed: false };
  for (const doc of docs) {
    for (const conn of findKey(doc, "xdt_api__v1__feed__timeline__connection")) {
      for (const { node } of conn.edges ?? []) {
        if (!node) continue;
        const post = node.media
          ? feedPost(node.media, { sponsored: false, suggested: false })
          : node.ad
            ? feedPost(node.ad.items?.[0] ?? node.ad.media, { sponsored: true, suggested: false })
            : node.explore_story
              ? feedPost(node.explore_story.media, { sponsored: false, suggested: true })
              : undefined;
        if (post) out.posts.push(post);
        else out.nonPostUnits++;
        if (node.end_of_feed_demarcator) out.endOfFeed = true;
      }
      const info = conn.page_info ?? {};
      out.feedPages.push({
        variant: conn.pagination_source === "following" ? "following" : "home",
        endCursor: info.end_cursor ?? null,
        hasNextPage: Boolean(info.has_next_page),
      });
    }
    for (const tray of findKey(doc, "xdt_api__v1__feed__reels_tray")) {
      (tray.tray ?? []).forEach((reel: Json, index: number) => {
        if (!reel?.id) return;
        out.tray.push({
          reelId: String(reel.id),
          handle: reel.user?.username,
          position: typeof reel.ranked_position === "number" ? reel.ranked_position : index + 1,
          latestReelMedia: reel.latest_reel_media,
          seen: Boolean(reel.seen) && reel.seen >= (reel.latest_reel_media ?? Infinity),
        });
      });
    }
    for (const conn of findKey(doc, "xdt_api__v1__feed__reels_media__connection")) {
      for (const { node } of conn.edges ?? []) {
        for (const item of node?.items ?? []) {
          const post = storyPost(node, item, trayOrder.get(String(node.id)));
          if (post) out.posts.push(post);
        }
      }
    }
    for (const viewer of findKey(doc, "xdt_viewer")) {
      if (viewer.user?.username) out.viewer = person(viewer.user);
    }
  }
  return out;
}
