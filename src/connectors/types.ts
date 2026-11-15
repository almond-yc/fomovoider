export type PlatformId = "x" | "instagram" | (string & {});
export type Id = `${PlatformId}:${string}`;
export type ISODate = string; // ISO-8601, UTC

export interface Person {
  id: Id;
  platform: PlatformId;
  handle: string;          // without @
  displayName: string;
  avatarUrl?: string;
  profileUrl?: string;
}

export interface Media {
  kind: "image" | "video" | "gif";
  url: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  altText?: string;
  durationSec?: number;
  blurhash?: string;       // tiny placeholder painted while the media loads
}

export interface Post {
  id: Id;
  platform: PlatformId;
  author: Person;
  title?: string;          // real titles only; never the author name
  createdAt: ISODate;
  text: string;            // plain text; links kept inline
  media: Media[];
  permalink: string;       // open in browser, never in the native app
  repostedBy?: Person;     // set when this reached the feed as a repost
  quoted?: Post;           // one level deep
  replyTo?: { id: Id; author?: Person };
  format?: "post" | "story";   // unset = "post"
  expiresAt?: ISODate;         // stories: when it disappears; the feed hides expired items
  // What the connector pulled out of the post, for any platform.
  extracted?: {
    place?: { name: string; lat?: number; lng?: number };
    event?: { title?: string; startsAt?: ISODate; place?: string };
    lifeUpdate?: string;       // one-line summary, e.g. "Moved to Lisbon"
  };
  // Scored by the connector from signals only it can see (interactions,
  // follows, history, interests). The app applies one threshold across platforms.
  relevance?: { score: number /* 0..1 */; reasons: string[] };
  raw?: unknown;
}

export interface Conversation {
  id: Id;
  platform: PlatformId;
  participants: Person[];  // excludes the account owner
  title?: string;          // group name
  lastMessage?: Message;
  unreadCount?: number;    // unset = platform doesn't expose it (X)
  // Set when the conversation exists but can't be read (e.g. X encrypted chats).
  unavailable?: { reason: "encrypted" | "unsupported" | (string & {}) };
  updatedAt: ISODate;
}

export interface Message {
  id: Id;
  conversationId: Id;
  sender: Person;
  isMine: boolean;
  sentAt: ISODate;
  text: string;
  media: Media[];
  raw?: unknown;
}

export interface Cookie {
  name: string;
  value: string;
  domain: string;          // e.g. ".x.com"
  path?: string;
  expires?: ISODate;
  httpOnly?: boolean;
  secure?: boolean;
}

// The only auth input. Connectors hold no auth state of their own.
export type Session =
  | { platform: PlatformId; kind: "cookies"; cookies: Cookie[]; userAgent?: string }
  | { platform: PlatformId; kind: "oauth"; accessToken: string; refreshToken?: string; expiresAt?: ISODate }
  // A paired phone the connector drives. deviceId points into the connector's own device table; no secrets here.
  | { platform: PlatformId; kind: "device"; deviceId: string };

export type Login =
  | { kind: "webview"; loginUrl: string; requiredCookies: string[] }        // app captures cookies
  | { kind: "oauth"; login(): Promise<Session> }                             // connector-provided helper
  | { kind: "device"; pair(): Promise<Session> };                            // connector-provided pairing flow

export interface Account {
  platform: PlatformId;
  me: Person;
}

export interface Page<T> {
  items: T[];              // newest first
  cursor: string;          // opaque; the app persists it and passes it back
  caughtUp: boolean;       // true = nothing older than the "since" point remains
}

export interface Capabilities {
  feed: boolean;
  chats: boolean;
  sendMessage: boolean;
  sendMedia: boolean;
  reply: boolean;
}

export type ConnectorError =
  | { kind: "session_expired" }                 // cookies or tokens no longer valid; app asks user to log in again
  | { kind: "rate_limited"; retryAt?: ISODate }
  | { kind: "budget_exhausted"; resetsAt?: ISODate } // our own spend cap (e.g. X credits)
  | { kind: "unsupported"; capability: keyof Capabilities }
  | { kind: "network" }
  | { kind: "platform"; message: string };

export interface Connector {
  platform: PlatformId;
  displayName: string;
  capabilities: Capabilities;

  login: Login;
  // Called when the connector refreshed an OAuth token mid-call; the app
  // persists the new session. Set by the app when it creates the connector.
  onSessionRefreshed?: (session: Session) => void;

  // Every call takes the session; connectors hold no auth state of their own.
  account(session: Session): Promise<Account>;  // also validates the cookies

  // Finite feed: everything newer than "since", newest first, at most limit.
  // since = the cursor the app stored at the end of the last session, or a
  // timestamp for the first run (e.g. 24h ago).
  feed(session: Session, opts: { since: string | ISODate; limit: number }): Promise<Page<Post>>;

  conversations(session: Session, opts: { cursor?: string; limit: number }): Promise<Page<Conversation>>;
  messages(session: Session, conversationId: Id, opts: { cursor?: string; limit: number }): Promise<Page<Message>>;
  send(session: Session, conversationId: Id, draft: { text: string; media?: Media[] }): Promise<Message>;
  markRead?(session: Session, conversationId: Id): Promise<void>;
  // Only where the platform allows it (X: replies to posts that mention the user).
  reply?(session: Session, postId: Id, draft: { text: string; media?: Media[] }): Promise<Post>;
}

export class ConnectorFailure extends Error {
  readonly error: ConnectorError;

  constructor(error: ConnectorError, message?: string, options?: { cause?: unknown }) {
    super(message ?? (error.kind === "platform" ? error.message : error.kind), options);
    this.name = "ConnectorFailure";
    this.error = error;
  }
}
