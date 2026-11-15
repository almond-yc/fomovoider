import { v, type Infer } from "convex/values";

// Mirrors the normalized types in the connector contract (v5).
// Connectors pass dates as ISO-8601 strings (the contract's ISODate). Stored
// rows hold every date as epoch milliseconds (numbers), converted at ingest,
// and every public query returns them as epoch milliseconds too.
//
// Engagement counts (likes, replies, reposts, views) are deliberately absent
// from every validator here: the product exists to remove that FOMO, so they
// are never stored or returned. Connectors may use them only inside
// relevance scoring. Because Convex validators reject unknown fields, a
// connector that passes a count fails ingest instead of storing it.

export const vPlatform = v.string();

export const vPerson = v.object({
  id: v.string(),
  platform: vPlatform,
  handle: v.string(),
  displayName: v.string(),
  avatarUrl: v.optional(v.string()),
  profileUrl: v.optional(v.string()),
});

const mediaFields = {
  kind: v.union(v.literal("image"), v.literal("video"), v.literal("gif")),
  url: v.string(),
  previewUrl: v.optional(v.string()),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
  altText: v.optional(v.string()),
  durationSec: v.optional(v.number()),
  // A tiny placeholder the app paints while the image loads.
  blurhash: v.optional(v.string()),
};

export const vMedia = v.object(mediaFields);

// Media with its Convex file storage copy. Ingest's media persistence sets
// storageId for platforms whose URLs expire; a connector that uploaded the
// file itself passes it (one file per post: retention deletes it with the post).
export const vStoredMedia = v.object({ ...mediaFields, storageId: v.optional(v.id("_storage")) });

// What connectors pass: the contract's Media, whose storageId is a plain
// string; ingest checks it names an existing file before storing it.
export const vMediaInput = v.object({ ...mediaFields, storageId: v.optional(v.string()) });

export const vStoredPerson = v.object({
  ...vPerson.fields,
  avatarStorageId: v.optional(v.id("_storage")),
});

export const vRelevance = v.object({
  score: v.number(),
  reasons: v.array(v.string()),
});

export const vExtracted = v.object({
  place: v.optional(
    v.object({ name: v.string(), lat: v.optional(v.number()), lng: v.optional(v.number()) }),
  ),
  event: v.optional(
    v.object({
      title: v.optional(v.string()),
      startsAt: v.optional(v.number()),
      place: v.optional(v.string()),
    }),
  ),
  lifeUpdate: v.optional(v.string()),
});

// Post text is cut to this many characters at ingest, to stay far from the
// 1 MB document limit.
export const MAX_TEXT_LENGTH = 10_000;

const postFields = {
  id: v.string(),
  platform: vPlatform,
  author: vPerson,
  // A real title only (X article, link-card headline, event name); never the
  // author's name.
  title: v.optional(v.string()),
  createdAt: v.number(),
  text: v.string(),
  media: v.array(vMedia),
  permalink: v.string(),
  repostedBy: v.optional(vPerson),
  replyTo: v.optional(v.object({ id: v.string(), author: v.optional(vPerson) })),
  format: v.optional(v.union(v.literal("post"), v.literal("story"))),
  expiresAt: v.optional(v.number()),
  // The platform's own markers: an ad, or a suggestion from an account the
  // user doesn't follow. Connectors record them; the app decides what to show.
  sponsored: v.optional(v.boolean()),
  suggested: v.optional(v.boolean()),
  extracted: v.optional(vExtracted),
  relevance: v.optional(vRelevance),
};

// A quoted post is one level deep, so it carries no quote of its own.
export const vQuotedPost = v.object(postFields);

export const vPostFields = {
  ...postFields,
  author: vStoredPerson,
  media: v.array(vStoredMedia),
  quoted: v.optional(vQuotedPost),
  // When ingest first stored the post, and when it last upserted it.
  fetchedAt: v.number(),
  updatedAt: v.number(),
};

// What connectors pass in: the contract's Post, with ISO date strings. `raw`
// is accepted and dropped: it is a debugging escape hatch and is never stored.
const postInputFields = {
  ...postFields,
  media: v.array(vMediaInput),
  createdAt: v.string(),
  expiresAt: v.optional(v.string()),
  extracted: v.optional(
    v.object({
      ...vExtracted.fields,
      event: v.optional(
        v.object({
          title: v.optional(v.string()),
          startsAt: v.optional(v.string()),
          place: v.optional(v.string()),
        }),
      ),
    }),
  ),
  raw: v.optional(v.any()),
};

export const vPostInput = v.object({
  ...postInputFields,
  quoted: v.optional(v.object({ ...postInputFields, media: v.array(vMedia) })),
});

const messageFields = {
  id: v.string(),
  conversationId: v.string(),
  sender: vPerson,
  isMine: v.boolean(),
  sentAt: v.number(),
  text: v.string(),
  media: v.array(vMedia),
  // Unset = delivered. Platforms that confirm sends later set pending, then sent or failed.
  delivery: v.optional(
    v.object({
      status: v.union(v.literal("pending"), v.literal("sent"), v.literal("failed")),
      error: v.optional(v.string()),
    }),
  ),
};

export const vMessageFields = messageFields;
export const vMessage = v.object(messageFields);
export const vMessageInput = v.object({
  ...messageFields,
  sentAt: v.string(),
  raw: v.optional(v.any()),
});

export const vUnavailable = v.object({ reason: v.string() });

export const vConversationFields = {
  id: v.string(),
  platform: vPlatform,
  participants: v.array(vPerson),
  title: v.optional(v.string()),
  lastMessage: v.optional(vMessage),
  unreadCount: v.optional(v.number()),
  unavailable: v.optional(vUnavailable),
  updatedAt: v.number(),
};

export const vConversationInput = v.object({
  ...vConversationFields,
  updatedAt: v.string(),
  lastMessage: v.optional(vMessageInput),
});

export const vCookie = v.object({
  name: v.string(),
  value: v.string(),
  domain: v.string(),
  path: v.optional(v.string()),
  expires: v.optional(v.string()),
  httpOnly: v.optional(v.boolean()),
  secure: v.optional(v.boolean()),
});

export const vSession = v.union(
  v.object({
    platform: vPlatform,
    kind: v.literal("cookies"),
    cookies: v.array(vCookie),
    userAgent: v.optional(v.string()),
  }),
  v.object({
    platform: vPlatform,
    kind: v.literal("oauth"),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    expiresAt: v.optional(v.string()),
  }),
  // A paired phone the connector drives; deviceId points into the connector's
  // own device table. No secrets here.
  v.object({
    platform: vPlatform,
    kind: v.literal("device"),
    deviceId: v.string(),
  }),
);

export const vConnectorError = v.union(
  v.object({ kind: v.literal("session_expired") }),
  v.object({ kind: v.literal("rate_limited"), retryAt: v.optional(v.string()) }),
  v.object({ kind: v.literal("budget_exhausted"), resetsAt: v.optional(v.string()) }),
  v.object({ kind: v.literal("unsupported"), capability: v.string() }),
  v.object({ kind: v.literal("network") }),
  v.object({ kind: v.literal("platform"), message: v.string() }),
);

// pending: new session, identity not confirmed yet (connector calls
// accounts.verifyIdentity). resetting: identity changed, old content is being
// purged. Ingest refuses in both.
export const vAccountStatus = v.union(
  v.literal("pending"),
  v.literal("resetting"),
  v.literal("active"),
  v.literal("expired"),
  v.literal("error"),
);

export type Session = Infer<typeof vSession>;
export type PostInput = Infer<typeof vPostInput>;
export type MessageInput = Infer<typeof vMessageInput>;
export type ConversationInput = Infer<typeof vConversationInput>;
