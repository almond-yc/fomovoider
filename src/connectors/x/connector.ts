import {
  type Account,
  type Capabilities,
  type Connector,
  ConnectorFailure,
  type Conversation,
  type Id,
  type ISODate,
  type Login,
  type Media,
  type Message,
  type Page,
  type Person,
  type Post,
  type Session,
} from "../types";
import type { XDmEvent, XListResponse, XTweet, XUser } from "./api-types";
import { OAuthClient, type OAuthSession, type PkceCrypto, webCrypto } from "./auth";
import { type BudgetKind, DailyBudget, MemoryUsageStore, type UsageStore } from "./budget";
import { type XConfig, dailyBudgetLimits } from "./config";
import { DM_EVENT_FIELDS, DM_EXPANSIONS, DM_USER_FIELDS, MAX_RESULTS, MEDIA_FIELDS, POST_EXPANSIONS, POST_FIELDS, USER_FIELDS, paths } from "./endpoints";
import { type CallContext, XHttp, problemSlug, xCause } from "./http";
import { XMapper, compareXIds, mapPerson, permalink, xId } from "./mappers";

export type FeedExclude = "replies" | "retweets";

export interface XConnectorOptions {
  config: XConfig;
  account?: Person;
  login?: Login;
  onSessionRefreshed?: (session: Session) => void;
  usage?: UsageStore;
  feedExclude?: FeedExclude[];
  allowReplyUrls?: boolean;
  fetch?: typeof fetch;
  crypto?: PkceCrypto;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const CURSOR_PREFIX = "x1";
const READS_PER_POST = 2;

interface FeedStream {
  endpoint: string;
  path: string;
  sinceId?: string;
  minResults: number;
  exclude?: string;
  token?: string;
  newest?: string;
  complete: boolean;
  stalled: boolean;
}
const URL_PATTERN = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|net|org|io|co|ly|gg|app|dev|me|xyz)\b/i;
const ENCRYPTION_PROBLEMS = new Set([
  "dm-recipient-encrypted-unavailable",
  "dm-sender-encrypted-unavailable",
  "encryption-required",
  "xchat-setup-required",
  "recipient-xchat-setup-required",
  "unencrypted-send-not-allowed",
]);

// Per stream: home/mentions is the newest post of the last finished pass
// (the next pass's since_id). A pass cut short by the limit or the budget
// also keeps where it stopped (homeToken/mentionsToken, X's pagination token
// toward older posts) and the newest post it saw (homeNewest/mentionsNewest),
// so the next run continues it instead of skipping the posts in between.
interface FeedCursor {
  home?: string;
  mentions?: string;
  startTime?: ISODate;
  homeToken?: string;
  homeNewest?: string;
  mentionsToken?: string;
  mentionsNewest?: string;
}

const PASS_FIELDS = ["homeToken", "homeNewest", "mentionsToken", "mentionsNewest"] as const;

export function parseFeedSince(since: string): FeedCursor {
  if (since.startsWith(`${CURSOR_PREFIX}|`)) {
    const [, home, mentions, startTime, ...pass] = since.split("|");
    const cursor: FeedCursor = { ...(home ? { home } : {}), ...(mentions ? { mentions } : {}), ...(startTime ? { startTime } : {}) };
    PASS_FIELDS.forEach((field, i) => {
      if (pass[i]) cursor[field] = pass[i];
    });
    return cursor;
  }
  if (!Number.isNaN(Date.parse(since))) return { startTime: new Date(since).toISOString() };
  throw new ConnectorFailure({ kind: "platform", message: `Unrecognized X feed cursor: ${since}` });
}

export function formatFeedCursor(c: FeedCursor): string {
  const fields = [CURSOR_PREFIX, c.home ?? "", c.mentions ?? "", c.startTime ?? ""];
  if (PASS_FIELDS.some((field) => c[field])) fields.push(...PASS_FIELDS.map((field) => c[field] ?? ""));
  return fields.join("|");
}

export function stripXId(id: Id): string {
  if (!id.startsWith("x:")) throw new ConnectorFailure({ kind: "platform", message: `Not an X id: ${id}` });
  return id.slice(2);
}

const noLogin: Login = {
  kind: "oauth",
  login: () => Promise.reject(new ConnectorFailure({ kind: "platform", message: "No X login configured; pass createXLogin() as the login option" })),
};

export class XConnector implements Connector {
  readonly platform = "x" as const;
  readonly displayName = "X";
  readonly capabilities: Capabilities = { feed: true, chats: true, sendMessage: true, sendMedia: false, reply: true };
  readonly login: Login;
  onSessionRefreshed?: (session: Session) => void;

  private readonly http: XHttp;
  private readonly budget: DailyBudget;
  private readonly now: () => number;
  private readonly people = new Map<string, XUser>();

  constructor(private readonly opts: XConnectorOptions) {
    const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.login = opts.login ?? noLogin;
    this.onSessionRefreshed = opts.onSessionRefreshed;
    const oauth = new OAuthClient({
      clientId: opts.config.clientId,
      clientSecret: opts.config.clientSecret,
      fetch: doFetch,
      crypto: opts.crypto ?? webCrypto,
      now: this.now,
    });
    this.http = new XHttp({
      oauth,
      fetch: doFetch,
      now: this.now,
      sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      onRefreshed: (session) => this.onSessionRefreshed?.(session),
    });
    this.budget = new DailyBudget(
      dailyBudgetLimits(opts.config),
      opts.usage ?? new MemoryUsageStore(),
      this.now,
    );
  }

  async account(session: Session): Promise<Account> {
    const ctx = this.context(session);
    return { platform: "x", me: mapPerson(await this.fetchMe(ctx)) };
  }

  remainingBudget(userId: string, kind: BudgetKind): Promise<number> {
    return this.budget.remaining(userId, kind);
  }

  async feed(session: Session, opts: { since: string | ISODate; limit: number }): Promise<Page<Post>> {
    const ctx = this.context(session);
    const since = parseFeedSince(opts.since);
    const me = await this.me(ctx);
    const grant = await this.reserve(me.id, "postReads", opts.limit * READS_PER_POST);
    const exclude = (this.opts.feedExclude ?? ["replies", "retweets"]).join(",") || undefined;
    const streams: FeedStream[] = [
      { endpoint: "mentions", path: paths.mentions(me.id), sinceId: since.mentions, token: since.mentionsToken, newest: since.mentionsNewest, minResults: 5, complete: false, stalled: false },
      { endpoint: "home_timeline", path: paths.homeTimeline(me.id), sinceId: since.home, token: since.homeToken, newest: since.homeNewest, minResults: 1, exclude, complete: false, stalled: false },
    ];
    const posts: Post[] = [];
    let spent = 0;
    try {
      for (;;) {
        const active = streams.filter((s) => !s.complete && !s.stalled);
        if (!active.length) break;
        for (const stream of active) {
          const size = Math.min(
            MAX_RESULTS,
            opts.limit - posts.length,
            Math.floor((grant - spent) / READS_PER_POST / active.length) || Math.floor((grant - spent) / READS_PER_POST),
          );
          if (size < stream.minResults) {
            stream.stalled = true;
            continue;
          }
          const page = await this.readPostPage(ctx, stream, size, since.startTime);
          spent += page.billed;
          posts.push(...page.posts);
        }
      }
    } finally {
      if (spent > grant) await this.budget.reserve(me.id, "postReads", spent - grant);
      else await this.budget.release(me.id, "postReads", grant - spent);
    }

    const byId = new Map<string, Post>();
    for (const post of posts) if (!byId.has(post.id)) byId.set(post.id, post);
    const sorted = [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : -compareXIds(a.id.slice(2), b.id.slice(2))));
    const [mentions, home] = streams as [FeedStream, FeedStream];
    // A finished stream moves its since_id to the pass's newest post; an
    // unfinished one keeps it and saves where to continue. caughtUp only when
    // both streams have read everything new: a pass resumed from the cursor
    // reads toward older posts only, so anything posted above it since is
    // unread until the next run's fresh pass, and the run isn't caught up.
    const resumed = Boolean(since.homeToken || since.mentionsToken);
    return {
      items: sorted,
      cursor: formatFeedCursor({
        home: home.complete ? (home.newest ?? since.home) : since.home,
        mentions: mentions.complete ? (mentions.newest ?? since.mentions) : since.mentions,
        ...(since.startTime ? { startTime: since.startTime } : {}),
        ...(home.complete ? {} : { homeToken: home.token, homeNewest: home.newest }),
        ...(mentions.complete ? {} : { mentionsToken: mentions.token, mentionsNewest: mentions.newest }),
      }),
      caughtUp: !resumed && streams.every((s) => s.complete),
    };
  }

  async conversations(session: Session, opts: { cursor?: string; limit: number }): Promise<Page<Conversation>> {
    const ctx = this.context(session);
    const me = await this.me(ctx);
    const res = await this.readDmEvents(ctx, me.id, "dm_events", paths.dmEvents, opts);
    const mapper = new XMapper(res.includes, [...this.people.values(), ...(await this.missingParticipants(ctx, me.id, res))]);
    return { items: mapper.conversations(res.data ?? [], me.id), cursor: res.meta?.next_token ?? "", caughtUp: !res.meta?.next_token };
  }

  async messages(session: Session, conversationId: Id, opts: { cursor?: string; limit: number }): Promise<Page<Message>> {
    const ctx = this.context(session);
    const me = await this.me(ctx);
    const id = stripXId(conversationId);
    const res = await this.readDmEvents(ctx, me.id, "dm_conversation_events", paths.conversationEvents(id), opts, "MessageCreate");
    const mapper = new XMapper(res.includes, [...this.people.values()]);
    const items = (res.data ?? [])
      .filter((e) => e.event_type === "MessageCreate")
      .sort((a, b) => compareXIds(b.id, a.id))
      .map((e) => mapper.message(e, me.id, id));
    return { items, cursor: res.meta?.next_token ?? "", caughtUp: !res.meta?.next_token };
  }

  async send(session: Session, conversationId: Id, draft: { text: string; media?: Media[] }): Promise<Message> {
    if (draft.media?.length) throw new ConnectorFailure({ kind: "unsupported", capability: "sendMedia" });
    if (!draft.text.trim()) throw new ConnectorFailure({ kind: "platform", message: "Message text is empty" });
    const ctx = this.context(session);
    const me = await this.me(ctx);
    await this.reserve(me.id, "writes", 1);
    const id = stripXId(conversationId);
    let res: { data: { dm_conversation_id: string; dm_event_id: string } };
    try {
      res = await this.http.request(ctx, { method: "POST", path: paths.conversationMessages(id), endpoint: "create_dm", body: { text: draft.text } });
    } catch (err) {
      await this.releaseFailedWrite(me.id, err);
      const cause = xCause(err);
      if (cause?.status !== 403) throw err;
      const encrypted = ENCRYPTION_PROBLEMS.has(problemSlug(cause.problem) ?? "");
      throw new ConnectorFailure(
        {
          kind: "platform",
          message: encrypted
            ? "This chat uses encrypted X Chat, which Fomovoider can't send to yet. Open it on X."
            : `X refused the message: ${cause.problem?.detail ?? "not permitted"}`,
        },
        undefined,
        { cause },
      );
    }
    return {
      id: xId(res.data.dm_event_id),
      conversationId: xId(res.data.dm_conversation_id),
      sender: mapPerson(me),
      isMine: true,
      sentAt: new Date(this.now()).toISOString(),
      text: draft.text,
      media: [],
      raw: res,
    };
  }

  async reply(session: Session, postId: Id, draft: { text: string; media?: Media[] }): Promise<Post> {
    if (draft.media?.length) throw new ConnectorFailure({ kind: "unsupported", capability: "sendMedia" });
    if (!draft.text.trim()) throw new ConnectorFailure({ kind: "platform", message: "Reply text is empty" });
    if (!this.opts.allowReplyUrls && URL_PATTERN.test(draft.text)) {
      throw new ConnectorFailure({ kind: "platform", message: "Replies with links cost $0.20 each on X instead of $0.01, so they are turned off. Remove the link." });
    }
    const ctx = this.context(session);
    const me = await this.me(ctx);
    await this.reserve(me.id, "writes", 1);
    const id = stripXId(postId);
    let res: { data: { id: string; text: string } };
    try {
      res = await this.http.request(ctx, { method: "POST", path: paths.tweets, endpoint: "create_post", body: { text: draft.text, reply: { in_reply_to_tweet_id: id } } });
    } catch (err) {
      await this.releaseFailedWrite(me.id, err);
      const cause = xCause(err);
      if (cause?.status !== 403) throw err;
      throw new ConnectorFailure(
        { kind: "platform", message: "X only lets apps reply to posts that @mention you or quote one of your posts. Open this post on X to reply." },
        undefined,
        { cause },
      );
    }
    return {
      id: xId(res.data.id),
      platform: "x",
      author: mapPerson(me),
      createdAt: new Date(this.now()).toISOString(),
      text: res.data.text,
      media: [],
      permalink: permalink(res.data.id, me.username),
      replyTo: { id: postId },
      raw: res,
    };
  }

  // Creates one X Activity subscription for this user. Creating needs the
  // user's token (dm.read for dm.* and chat.*, tweet.read for posts);
  // listing and deleting go through the app token (activity.ts), since the
  // user-token list also wants like.read, which Fomovoider doesn't ask for.
  // Returns undefined when X answers DuplicateSubscription: the user already
  // has one for this event type (X's list doesn't always show it).
  async createActivitySubscription(session: Session, opts: { webhookId: string; eventType: string; tag: string }): Promise<string | undefined> {
    const ctx = this.context(session);
    const me = await this.me(ctx);
    try {
      const res = await this.http.request<{ data: { subscription: { subscription_id: string } } }>(ctx, {
        method: "POST",
        path: paths.activitySubscriptions,
        endpoint: "create_activity_subscription",
        body: { event_type: opts.eventType, filter: { user_id: me.id }, webhook_id: opts.webhookId, tag: opts.tag },
      });
      return res.data.subscription.subscription_id;
    } catch (err) {
      const cause = xCause(err);
      if (cause?.status === 400 && cause.problem?.errors?.some((e) => e.message?.startsWith("DuplicateSubscription"))) return undefined;
      throw err;
    }
  }

  // Every DM event newer than sinceId, one page at a time, newest first, for
  // a backend that keeps its own history. cursor continues an unfinished pass.
  async inbox(
    session: Session,
    opts: { sinceId?: string; cursor?: string; limit: number },
  ): Promise<{ conversations: Conversation[]; messages: Message[]; cursor?: string; newestId?: string; reachedSince: boolean }> {
    const ctx = this.context(session);
    const me = await this.me(ctx);
    const res = await this.readDmEvents(ctx, me.id, "dm_events", paths.dmEvents, opts);
    const events = res.data ?? [];
    const fresh = opts.sinceId ? events.filter((e) => compareXIds(e.id, opts.sinceId!) > 0) : events;
    const reachedSince = fresh.length < events.length;
    const mapper = new XMapper(res.includes, [...this.people.values(), ...(await this.missingParticipants(ctx, me.id, { ...res, data: fresh }))]);
    const newest = events.reduce<string | undefined>((max, e) => (max === undefined || compareXIds(e.id, max) > 0 ? e.id : max), undefined);
    return {
      conversations: mapper.conversations(fresh, me.id),
      messages: fresh.filter((e) => e.event_type === "MessageCreate").map((e) => mapper.message(e, me.id)),
      ...(!reachedSince && res.meta?.next_token ? { cursor: res.meta.next_token } : {}),
      ...(newest ? { newestId: newest } : {}),
      reachedSince,
    };
  }

  private context(session: Session): CallContext {
    if (session.kind !== "oauth" || session.platform !== "x") {
      throw new ConnectorFailure({ kind: "session_expired" }, "The X connector needs an X OAuth session; log in to X again");
    }
    return { session: session as OAuthSession };
  }

  private sessionKey(session: OAuthSession): string {
    return session.refreshToken ?? session.accessToken;
  }

  private async me(ctx: CallContext): Promise<XUser> {
    const known = this.opts.account;
    const cached = this.people.get(this.sessionKey(ctx.session));
    if (cached) return cached;
    if (known) return { id: stripXId(known.id), username: known.handle, name: known.displayName, ...(known.avatarUrl ? { profile_image_url: known.avatarUrl } : {}) };
    return this.fetchMe(ctx);
  }

  private async fetchMe(ctx: CallContext): Promise<XUser> {
    const original = this.sessionKey(ctx.session);
    const res = await this.http.request<{ data: XUser }>(ctx, { method: "GET", path: paths.me, endpoint: "users_me", query: { "user.fields": USER_FIELDS } });
    this.people.set(original, res.data);
    this.people.set(this.sessionKey(ctx.session), res.data);
    return res.data;
  }

  private async reserve(userId: string, kind: BudgetKind, amount: number): Promise<number> {
    const granted = await this.budget.reserve(userId, kind, amount);
    if (granted <= 0) {
      throw new ConnectorFailure(
        { kind: "budget_exhausted", resetsAt: new Date(this.budget.nextResetAt()).toISOString() },
        `Fomovoider's daily X ${kind} budget is used up`,
      );
    }
    return granted;
  }

  private async releaseFailedWrite(userId: string, err: unknown): Promise<void> {
    const status = xCause(err)?.status;
    if (status !== undefined && status < 500) await this.budget.release(userId, "writes", 1);
  }

  private async readPostPage(ctx: CallContext, stream: FeedStream, size: number, startTime: string | undefined): Promise<{ posts: Post[]; billed: number }> {
    const res = await this.http.request<XListResponse<XTweet>>(ctx, {
      method: "GET",
      path: stream.path,
      endpoint: stream.endpoint,
      query: {
        max_results: size,
        pagination_token: stream.token,
        since_id: stream.sinceId,
        start_time: stream.sinceId ? undefined : startTime,
        exclude: stream.exclude,
        "tweet.fields": POST_FIELDS,
        expansions: POST_EXPANSIONS,
        "user.fields": USER_FIELDS,
        "media.fields": MEDIA_FIELDS,
      },
    });
    const tweets = res.data ?? [];
    stream.newest ??= res.meta?.newest_id;
    stream.token = res.meta?.next_token;
    stream.complete = !stream.token;
    const mapper = new XMapper(res.includes);
    return { posts: tweets.map((t) => mapper.post(t)), billed: tweets.length + (res.includes?.tweets?.length ?? 0) };
  }

  // X only expands the users an event names (sender_id, participant_ids), so
  // the other person in a 1:1 conversation whose page holds only your own
  // messages comes back without a profile. Looks those users up, billed like a
  // DM event read ($0.01 each); when the budget is spent or the lookup fails
  // they stay unnamed.
  private async missingParticipants(ctx: CallContext, meId: string, res: XListResponse<XDmEvent>): Promise<XUser[]> {
    const known = new Set([meId, ...(res.includes?.users ?? []).map((u) => u.id), ...[...this.people.values()].map((u) => u.id)]);
    const missing = new Set<string>();
    for (const event of res.data ?? []) {
      const ids = [...(/^\d+-\d+$/.test(event.dm_conversation_id ?? "") ? event.dm_conversation_id!.split("-") : []), ...(event.participant_ids ?? []), ...(event.sender_id ? [event.sender_id] : [])];
      for (const id of ids) if (!known.has(id)) missing.add(id);
    }
    if (!missing.size) return [];
    const grant = await this.budget.reserve(meId, "dmEventReads", Math.min(MAX_RESULTS, missing.size));
    if (grant <= 0) return [];
    let found: XUser[] = [];
    try {
      const res = await this.http.request<{ data?: XUser[] }>(ctx, {
        method: "GET",
        path: paths.users,
        endpoint: "users_lookup",
        query: { ids: [...missing].slice(0, grant).join(","), "user.fields": DM_USER_FIELDS },
      });
      found = res.data ?? [];
      return found;
    } catch (err) {
      // Names are enrichment: a failed lookup leaves the participants unnamed
      // rather than losing the DM page already read and paid for.
      if (err instanceof ConnectorFailure && err.error.kind === "session_expired") throw err;
      return [];
    } finally {
      await this.budget.release(meId, "dmEventReads", grant - found.length);
    }
  }

  private async readDmEvents(ctx: CallContext, userId: string, endpoint: string, path: string, opts: { cursor?: string; limit: number }, eventTypes?: string) {
    const grant = await this.reserve(userId, "dmEventReads", Math.max(1, Math.min(MAX_RESULTS, opts.limit)));
    let used = 0;
    try {
      const res = await this.http.request<XListResponse<XDmEvent>>(ctx, {
      method: "GET",
      path,
      endpoint,
      query: {
        max_results: grant,
        pagination_token: opts.cursor || undefined,
        event_types: eventTypes,
        "dm_event.fields": DM_EVENT_FIELDS,
        expansions: DM_EXPANSIONS,
        "user.fields": DM_USER_FIELDS,
        "media.fields": MEDIA_FIELDS,
      },
    });
      used = res.data?.length ?? 0;
      return res;
    } finally {
      await this.budget.release(userId, "dmEventReads", grant - used);
    }
  }
}

