/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounts from "../accounts.js";
import type * as auth from "../auth.js";
import type * as chat_connectors from "../chat/connectors.js";
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as feed from "../feed.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as instagram_agent from "../instagram/agent.js";
import type * as instagram_common from "../instagram/common.js";
import type * as instagram_crons from "../instagram/crons.js";
import type * as instagram_devices from "../instagram/devices.js";
import type * as instagram_dms from "../instagram/dms.js";
import type * as instagram_killSwitch from "../instagram/killSwitch.js";
import type * as instagram_limits from "../instagram/limits.js";
import type * as instagram_schedule from "../instagram/schedule.js";
import type * as instagram_send from "../instagram/send.js";
import type * as instagram_webview from "../instagram/webview.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_media from "../lib/media.js";
import type * as lib_normalize from "../lib/normalize.js";
import type * as lib_posts from "../lib/posts.js";
import type * as lib_validators from "../lib/validators.js";
import type * as media from "../media.js";
import type * as messages from "../messages.js";
import type * as postStates from "../postStates.js";
import type * as retention from "../retention.js";
import type * as users from "../users.js";
import type * as x_auth from "../x/auth.js";
import type * as x_chat from "../x/chat.js";
import type * as x_chatConnection from "../x/chatConnection.js";
import type * as x_chatKeys from "../x/chatKeys.js";
import type * as x_chatNode from "../x/chatNode.js";
import type * as x_crons from "../x/crons.js";
import type * as x_send from "../x/send.js";
import type * as x_state from "../x/state.js";
import type * as x_sync from "../x/sync.js";
import type * as x_webhook from "../x/webhook.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  auth: typeof auth;
  "chat/connectors": typeof chat_connectors;
  conversations: typeof conversations;
  crons: typeof crons;
  feed: typeof feed;
  http: typeof http;
  ingest: typeof ingest;
  "instagram/agent": typeof instagram_agent;
  "instagram/common": typeof instagram_common;
  "instagram/crons": typeof instagram_crons;
  "instagram/devices": typeof instagram_devices;
  "instagram/dms": typeof instagram_dms;
  "instagram/killSwitch": typeof instagram_killSwitch;
  "instagram/limits": typeof instagram_limits;
  "instagram/schedule": typeof instagram_schedule;
  "instagram/send": typeof instagram_send;
  "instagram/webview": typeof instagram_webview;
  "lib/auth": typeof lib_auth;
  "lib/media": typeof lib_media;
  "lib/normalize": typeof lib_normalize;
  "lib/posts": typeof lib_posts;
  "lib/validators": typeof lib_validators;
  media: typeof media;
  messages: typeof messages;
  postStates: typeof postStates;
  retention: typeof retention;
  users: typeof users;
  "x/auth": typeof x_auth;
  "x/chat": typeof x_chat;
  "x/chatConnection": typeof x_chatConnection;
  "x/chatKeys": typeof x_chatKeys;
  "x/chatNode": typeof x_chatNode;
  "x/crons": typeof x_crons;
  "x/send": typeof x_send;
  "x/state": typeof x_state;
  "x/sync": typeof x_sync;
  "x/webhook": typeof x_webhook;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
