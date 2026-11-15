import { v, type Infer } from "convex/values";

// Mirrors the normalized types in the connector contract (draft v3).
// ISODate fields are stored as ISO-8601 UTC strings normalized with
// Date#toISOString, so they sort and compare correctly as strings.

export const vPlatform = v.string();

export const vPerson = v.object({
  id: v.string(),
  platform: vPlatform,
  handle: v.string(),
  displayName: v.string(),
  avatarUrl: v.optional(v.string()),
  profileUrl: v.optional(v.string()),
});

export const vMedia = v.object({
  kind: v.union(v.literal("image"), v.literal("video"), v.literal("gif")),
  url: v.string(),
  previewUrl: v.optional(v.string()),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
  altText: v.optional(v.string()),
  durationSec: v.optional(v.number()),
});

export const vRelevance = v.object({
  score: v.number(),
  reasons: v.array(v.string()),
});

const postFields = {
  id: v.string(),
  platform: vPlatform,
  author: vPerson,
  createdAt: v.string(),
  text: v.string(),
  media: v.array(vMedia),
  permalink: v.string(),
  repostedBy: v.optional(vPerson),
  replyTo: v.optional(v.object({ id: v.string(), author: v.optional(vPerson) })),
  relevance: v.optional(vRelevance),
};

// A quoted post is one level deep, so it carries no quote of its own.
export const vQuotedPost = v.object(postFields);

export const vPostFields = { ...postFields, quoted: v.optional(vQuotedPost) };

// What connectors pass in. `raw` is accepted and dropped: it is a debugging
// escape hatch and is never stored.
export const vPostInput = v.object({
  ...vPostFields,
  quoted: v.optional(v.object({ ...postFields, raw: v.optional(v.any()) })),
  raw: v.optional(v.any()),
});

const messageFields = {
  id: v.string(),
  conversationId: v.string(),
  sender: vPerson,
  isMine: v.boolean(),
  sentAt: v.string(),
  text: v.string(),
  media: v.array(vMedia),
};

export const vMessageFields = messageFields;
export const vMessage = v.object(messageFields);
export const vMessageInput = v.object({ ...messageFields, raw: v.optional(v.any()) });

export const vUnavailable = v.object({ reason: v.string() });

export const vConversationFields = {
  id: v.string(),
  platform: vPlatform,
  participants: v.array(vPerson),
  title: v.optional(v.string()),
  lastMessage: v.optional(vMessage),
  unreadCount: v.optional(v.number()),
  unavailable: v.optional(vUnavailable),
  updatedAt: v.string(),
};

export const vConversationInput = v.object({
  ...vConversationFields,
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
);

export const vConnectorError = v.union(
  v.object({ kind: v.literal("session_expired") }),
  v.object({ kind: v.literal("rate_limited"), retryAt: v.optional(v.string()) }),
  v.object({ kind: v.literal("budget_exhausted"), resetsAt: v.optional(v.string()) }),
  v.object({ kind: v.literal("unsupported"), capability: v.string() }),
  v.object({ kind: v.literal("network") }),
  v.object({ kind: v.literal("platform"), message: v.string() }),
);

export const vAccountStatus = v.union(
  v.literal("active"),
  v.literal("expired"),
  v.literal("error"),
);

export type Session = Infer<typeof vSession>;
export type PostInput = Infer<typeof vPostInput>;
export type MessageInput = Infer<typeof vMessageInput>;
export type ConversationInput = Infer<typeof vConversationInput>;
