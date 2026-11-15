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
import type * as lib_auth from "../lib/auth.js";
import type * as lib_media from "../lib/media.js";
import type * as lib_normalize from "../lib/normalize.js";
import type * as lib_posts from "../lib/posts.js";
import type * as lib_validators from "../lib/validators.js";
import type * as media from "../media.js";
import type * as messages from "../messages.js";
import type * as postStates from "../postStates.js";
import type * as retention from "../retention.js";
import type * as x_auth from "../x/auth.js";
import type * as x_chat from "../x/chat.js";
import type * as x_crons from "../x/crons.js";
import type * as x_send from "../x/send.js";
import type * as x_state from "../x/state.js";
import type * as x_sync from "../x/sync.js";

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
  "lib/auth": typeof lib_auth;
  "lib/media": typeof lib_media;
  "lib/normalize": typeof lib_normalize;
  "lib/posts": typeof lib_posts;
  "lib/validators": typeof lib_validators;
  media: typeof media;
  messages: typeof messages;
  postStates: typeof postStates;
  retention: typeof retention;
  "x/auth": typeof x_auth;
  "x/chat": typeof x_chat;
  "x/crons": typeof x_crons;
  "x/send": typeof x_send;
  "x/state": typeof x_state;
  "x/sync": typeof x_sync;
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
