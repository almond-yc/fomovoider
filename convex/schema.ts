import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vAccountStatus,
  vConnectorError,
  vConversationFields,
  vMessageFields,
  vPerson,
  vPlatform,
  vPostFields,
  vSession,
} from "./lib/validators";
// Connector-owned tables: one import and one spread per connector, e.g.
// import { instagramTables } from "./instagram/schema";
// See convex/README.md, "Connector-owned tables".

const sharedTables = {
  // users, authSessions, authAccounts, ... from Convex Auth.
  ...authTables,

  // One per user and platform. Holds the connector Session (secret).
  connectedAccounts: defineTable({
    userId: v.id("users"),
    platform: vPlatform,
    session: vSession,
    me: v.optional(vPerson),
    status: vAccountStatus,
    lastError: v.optional(vConnectorError),
    lastSyncedAt: v.optional(v.number()),
  })
    .index("by_userId_and_platform", ["userId", "platform"])
    .index("by_platform", ["platform"]),

  // Per user and platform: the connector's opaque cursor and caughtUp flag
  // from the last sync, and seenUntil, the createdAt (epoch ms) of the newest post the
  // user had reached when they last hit "You're all caught up". The feed
  // ends at seenUntil.
  feedCursors: defineTable({
    userId: v.id("users"),
    platform: vPlatform,
    cursor: v.optional(v.string()),
    caughtUp: v.boolean(),
    seenUntil: v.optional(v.number()),
  }).index("by_userId_and_platform", ["userId", "platform"]),

  // Dates are epoch ms (see lib/validators.ts). by_createdAt and by_expiresAt
  // serve the retention cron.
  posts: defineTable({ userId: v.id("users"), ...vPostFields })
    .index("by_userId_and_id", ["userId", "id"])
    .index("by_userId_and_createdAt", ["userId", "createdAt"])
    .index("by_createdAt", ["createdAt"])
    .index("by_expiresAt", ["expiresAt"]),

  // What a user did with one of their posts. Times are epoch ms.
  postStates: defineTable({
    userId: v.id("users"),
    postId: v.id("posts"),
    seenAt: v.optional(v.number()),
    openedAt: v.optional(v.number()),
    hiddenAt: v.optional(v.number()),
    savedAt: v.optional(v.number()),
  })
    .index("by_userId_and_postId", ["userId", "postId"])
    .index("by_userId_and_hiddenAt", ["userId", "hiddenAt"])
    .index("by_postId", ["postId"]),

  conversations: defineTable({ userId: v.id("users"), ...vConversationFields })
    .index("by_userId_and_id", ["userId", "id"])
    .index("by_userId_and_updatedAt", ["userId", "updatedAt"]),

  messages: defineTable({ userId: v.id("users"), ...vMessageFields })
    .index("by_userId_and_id", ["userId", "id"])
    .index("by_userId_and_conversationId_and_sentAt", [
      "userId",
      "conversationId",
      "sentAt",
    ]),
};

export default defineSchema({
  ...sharedTables,
  // ...instagramTables,
});
