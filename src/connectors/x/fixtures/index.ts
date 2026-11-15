import usersMe from "./users-me.json";
import token from "./token.json";
import tokenRefreshed from "./token-refreshed.json";
import tokenInvalid from "./token-invalid.json";
import homeTimeline from "./home-timeline.json";
import homeTimelineEmpty from "./home-timeline-empty.json";
import mentions from "./mentions.json";
import dmEvents from "./dm-events.json";
import conversationEvents from "./conversation-events.json";
import createPost from "./create-post.json";
import createDm from "./create-dm.json";
import errorRateLimited from "./error-rate-limited.json";
import errorReplyNotSummoned from "./error-reply-not-summoned.json";
import errorDmEncrypted from "./error-dm-encrypted.json";
import errorDmNotAccepting from "./error-dm-not-accepting.json";
import errorOutOfCredits from "./error-out-of-credits.json";
import errorUsageCapped from "./error-usage-capped.json";
import errorUnauthorized from "./error-unauthorized.json";

export const fixtures = {
  "users-me": usersMe,
  "token": token,
  "token-refreshed": tokenRefreshed,
  "token-invalid": tokenInvalid,
  "home-timeline": homeTimeline,
  "home-timeline-empty": homeTimelineEmpty,
  "mentions": mentions,
  "dm-events": dmEvents,
  "conversation-events": conversationEvents,
  "create-post": createPost,
  "create-dm": createDm,
  "error-rate-limited": errorRateLimited,
  "error-reply-not-summoned": errorReplyNotSummoned,
  "error-dm-encrypted": errorDmEncrypted,
  "error-dm-not-accepting": errorDmNotAccepting,
  "error-out-of-credits": errorOutOfCredits,
  "error-usage-capped": errorUsageCapped,
  "error-unauthorized": errorUnauthorized,
};

export type FixtureName = keyof typeof fixtures;
