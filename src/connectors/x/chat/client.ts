import { ConnectorFailure, type Conversation, type Id, type ISODate, type Person, type Session } from "../../types";
import type { XUser } from "../api-types";
import { OAuthClient, type OAuthSession, type PkceCrypto, webCrypto } from "../auth";
import { DailyBudget, MemoryUsageStore, type UsageStore } from "../budget";
import { type XConfig, dailyBudgetLimits } from "../config";
import { type CallContext, XHttp, problemSlug, xCause } from "../http";
import { mapPerson } from "../mappers";
import type { XChatConversation, XChatConversationsResponse, XChatEventsResponse, XChatSendResponse, XPublicKeysResponse } from "./api-types";
import {
  CHAT_CONVERSATION_EXPANSIONS,
  CHAT_CONVERSATION_FIELDS,
  CHAT_EVENT_FIELDS,
  CHAT_USER_FIELDS,
  MAX_CHAT_EVENTS,
  PUBLIC_KEY_FIELDS,
  chatPaths,
} from "./endpoints";
import { chatConversationId, chatTarget, eventSortKey, snowflakeTime } from "./ids";

export interface XChatClientOptions {
  config: XConfig;
  usage?: UsageStore;
  onSessionRefreshed?: (session: Session) => void;
  fetch?: typeof fetch;
  crypto?: PkceCrypto;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// One stored, still-encrypted X Chat event.
export interface ChatEventRow {
  id: string;
  encodedEvent: string;
  keyVersion?: string;
  senderId?: string;
  createdAt?: ISODate;
}

// Public keys of one participant, in the Chat XDK's SigningKeyEntry shape.
export interface ChatSigningKey {
  userId: string;
  publicKeyVersion: string;
  publicKey: string;
  identityPublicKey: string;
  identityPublicKeySignature: string;
}

export interface ChatKeyContext {
  meId: string;
  // Null when this X account has never set up X Chat.
  signingKeyVersion: string | null;
  juiceboxConfig: string | null;
  signingKeys: ChatSigningKey[];
}

export interface ChatSendPayload {
  messageId: string;
  encodedMessageCreateEvent: string;
  encodedMessageEventSignature: string;
  xdkVersion?: string;
}

export const LOCKED = { reason: "locked" } as const;

const SETUP_PROBLEMS = new Set(["xchat-setup-required", "recipient-xchat-setup-required"]);

// Reads and sends X Chat (encrypted DMs) as ciphertext. It never sees a
// passcode, a private key or plaintext: decryption happens on the device.
export class XChatClient {
  private readonly http: XHttp;
  private readonly budget: DailyBudget;
  private readonly now: () => number;

  constructor(private readonly opts: XChatClientOptions) {
    const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.http = new XHttp({
      oauth: new OAuthClient({
        clientId: opts.config.clientId,
        clientSecret: opts.config.clientSecret,
        fetch: doFetch,
        crypto: opts.crypto ?? webCrypto,
        now: this.now,
      }),
      fetch: doFetch,
      now: this.now,
      sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      onRefreshed: (session) => opts.onSessionRefreshed?.(session),
    });
    this.budget = new DailyBudget(dailyBudgetLimits(opts.config), opts.usage ?? new MemoryUsageStore(), this.now);
  }

  // The inbox's X Chat conversations active since `since`, newest first, as
  // locked contract Conversations: participants and time only, no content.
  // cursor continues an unfinished pass; nextCursor is set while one remains.
  async conversations(
    session: Session,
    opts: { meId: string; since?: ISODate; cursor?: string; limit: number },
  ): Promise<{ conversations: Conversation[]; newestAt?: ISODate; nextCursor?: string; caughtUp: boolean }> {
    const ctx = context(session);
    const grant = await this.reserve(opts.meId, "chatEventReads", Math.max(1, Math.min(opts.limit, 200)));
    const conversations: Conversation[] = [];
    let token: string | undefined = opts.cursor;
    let used = 0;
    let hasMore = true;
    try {
      while (hasMore && used < grant) {
        const res = await this.http.request<XChatConversationsResponse>(ctx, {
          method: "GET",
          path: chatPaths.conversations,
          endpoint: "chat_conversations",
          query: {
            max_results: grant - used,
            pagination_token: token,
            start_time: opts.since,
            "chat_conversation.fields": CHAT_CONVERSATION_FIELDS,
            expansions: CHAT_CONVERSATION_EXPANSIONS,
            "user.fields": CHAT_USER_FIELDS,
          },
        });
        const page = res.data ?? [];
        used += page.length;
        const people = new Map((res.includes?.users ?? []).map((u) => [u.id, u]));
        for (const c of page) conversations.push(this.lockedConversation(c, opts.meId, people));
        token = res.meta?.next_token;
        hasMore = Boolean(res.meta?.has_more ?? token) && Boolean(token);
        if (!page.length && !hasMore) break;
      }
    } finally {
      await this.budget.release(opts.meId, "chatEventReads", grant - used);
    }
    const newestAt = conversations.reduce<ISODate | undefined>((max, c) => (!max || c.updatedAt > max ? c.updatedAt : max), undefined);
    return { conversations, newestAt, ...(hasMore ? { nextCursor: token } : {}), caughtUp: !hasMore };
  }

  // Encrypted events of one conversation newer than `afterId`, newest first,
  // plus the key-change events X returns alongside them for decryption.
  // cursor continues an unfinished pass; nextCursor is set while one remains.
  async events(
    session: Session,
    conversationId: Id,
    opts: { meId: string; afterId?: string; cursor?: string; limit: number },
  ): Promise<{ events: ChatEventRow[]; keyEvents: string[]; nextCursor?: string; caughtUp: boolean }> {
    const ctx = context(session);
    const target = chatTarget(conversationId, opts.meId);
    const grant = await this.reserve(opts.meId, "chatEventReads", Math.max(1, Math.min(opts.limit, MAX_CHAT_EVENTS)));
    const events: ChatEventRow[] = [];
    const keyEvents = new Set<string>();
    const after = opts.afterId === undefined ? undefined : eventSortKey(opts.afterId);
    let token: string | undefined = opts.cursor;
    let billed = 0;
    let reachedStored = false;
    let hasMore = true;
    try {
      while (hasMore && !reachedStored && billed < grant) {
        const res = await this.http.request<XChatEventsResponse>(ctx, {
          method: "GET",
          path: chatPaths.events(target),
          endpoint: "chat_conversation_events",
          query: { max_results: Math.min(MAX_CHAT_EVENTS, grant - billed), pagination_token: token, "chat_message_event.fields": CHAT_EVENT_FIELDS },
        });
        const page = res.data ?? [];
        billed += page.length;
        for (const e of page) {
          if (after !== undefined && eventSortKey(e.id) <= after) {
            reachedStored = true;
            break;
          }
          const createdAt = e.created_at ?? isoFromMs(snowflakeTime(e.id));
          events.push({
            id: e.id,
            encodedEvent: e.encoded_event,
            ...(e.conversation_key_version ? { keyVersion: e.conversation_key_version } : {}),
            ...(e.sender_id ? { senderId: e.sender_id } : {}),
            ...(createdAt ? { createdAt } : {}),
          });
        }
        for (const k of res.meta?.conversation_key_events ?? []) keyEvents.add(k);
        token = res.meta?.next_token;
        hasMore = Boolean(token) && res.meta?.has_more !== false;
      }
    } finally {
      if (billed > grant) await this.budget.reserve(opts.meId, "chatEventReads", billed - grant);
      else await this.budget.release(opts.meId, "chatEventReads", grant - billed);
    }
    const caughtUp = reachedStored || !hasMore;
    return { events, keyEvents: [...keyEvents], ...(caughtUp ? {} : { nextCursor: token }), caughtUp };
  }

  // What the device needs to unlock and verify: the account's own key record
  // (with the Juicebox config) and every participant's public keys.
  async keyContext(session: Session, opts: { meId: string; participantIds: string[] }): Promise<ChatKeyContext> {
    const ctx = context(session);
    const userIds = [...new Set([opts.meId, ...opts.participantIds])];
    const granted = await this.reserve(opts.meId, "chatEventReads", userIds.length);
    if (granted < userIds.length) {
      await this.budget.release(opts.meId, "chatEventReads", granted);
      throw new ConnectorFailure(
        { kind: "budget_exhausted", resetsAt: new Date(this.budget.nextResetAt()).toISOString() },
        "Fomovoider's daily X chatEventReads budget can't cover this chat's public keys",
      );
    }
    const signingKeys: ChatSigningKey[] = [];
    let mine: { version: string; juiceboxConfig: unknown } | undefined;
    for (const userId of userIds) {
      const res = await this.http.request<XPublicKeysResponse>(ctx, {
        method: "GET",
        path: chatPaths.publicKeys(userId),
        endpoint: "chat_public_keys",
        query: { "public_key.fields": PUBLIC_KEY_FIELDS },
      });
      for (const r of res.data ?? []) {
        if (!r.public_key || !r.public_key_version || !r.signing_public_key || !r.identity_public_key_signature) continue;
        signingKeys.push({
          userId,
          publicKeyVersion: r.public_key_version,
          publicKey: r.signing_public_key,
          identityPublicKey: r.public_key,
          identityPublicKeySignature: r.identity_public_key_signature,
        });
        if (userId === opts.meId && r.juicebox_config && (!mine || compareVersions(r.public_key_version, mine.version) > 0)) {
          mine = { version: r.public_key_version, juiceboxConfig: r.juicebox_config };
        }
      }
    }
    return {
      meId: opts.meId,
      signingKeyVersion: mine?.version ?? null,
      juiceboxConfig: mine ? (typeof mine.juiceboxConfig === "string" ? mine.juiceboxConfig : JSON.stringify(mine.juiceboxConfig)) : null,
      signingKeys,
    };
  }

  // Posts a message the device already encrypted and signed with the Chat XDK.
  async send(session: Session, conversationId: Id, opts: { meId: string; payload: ChatSendPayload }): Promise<{ encodedMessageEvent?: string }> {
    const ctx = context(session);
    const target = chatTarget(conversationId, opts.meId);
    const { messageId, encodedMessageCreateEvent, encodedMessageEventSignature, xdkVersion } = opts.payload;
    if (!messageId || !encodedMessageCreateEvent || !encodedMessageEventSignature) {
      throw new ConnectorFailure({ kind: "platform", message: "X Chat messages must be encrypted on the device before sending" });
    }
    await this.reserve(opts.meId, "writes", 1);
    try {
      const res = await this.http.request<XChatSendResponse>(ctx, {
        method: "POST",
        path: chatPaths.messages(target),
        endpoint: "chat_send_message",
        body: {
          message_id: messageId,
          encoded_message_create_event: encodedMessageCreateEvent,
          encoded_message_event_signature: encodedMessageEventSignature,
          ...(xdkVersion ? { xdk_version: xdkVersion } : {}),
        },
      });
      return { encodedMessageEvent: res.data?.encoded_message_event };
    } catch (err) {
      const cause = xCause(err);
      if (cause?.status !== undefined && cause.status < 500) await this.budget.release(opts.meId, "writes", 1);
      if (cause?.status === 403 || cause?.status === 400) {
        const slug = problemSlug(cause.problem) ?? "";
        const message = SETUP_PROBLEMS.has(slug)
          ? "X Chat isn't set up for this conversation on X."
          : slug === "recipient-not-messageable"
            ? "X doesn't let you message this person (closed inbox or a block)."
            : `X refused the message: ${cause.problem?.detail ?? "not permitted"}`;
        throw new ConnectorFailure({ kind: "platform", message }, undefined, { cause });
      }
      throw err;
    }
  }

  private lockedConversation(c: XChatConversation, meId: string, people: Map<string, XUser>): Conversation {
    const others = (c.participant_ids?.length ? c.participant_ids : (c.member_ids ?? [])).filter((id) => id !== meId);
    const updatedAt = c.updated_at ?? isoFromMs(snowflakeTime(c.newest_event_id)) ?? c.created_at ?? new Date(this.now()).toISOString();
    return {
      id: chatConversationId(c.id),
      platform: "x",
      participants: others.map((id): Person => {
        const user = people.get(id);
        return user ? mapPerson(user) : { id: `x:${id}`, platform: "x", handle: "", displayName: "" };
      }),
      unavailable: LOCKED,
      updatedAt: new Date(updatedAt).toISOString(),
    };
  }

  private async reserve(userId: string, kind: "chatEventReads" | "writes", amount: number): Promise<number> {
    const granted = await this.budget.reserve(userId, kind, amount);
    if (granted <= 0) {
      throw new ConnectorFailure(
        { kind: "budget_exhausted", resetsAt: new Date(this.budget.nextResetAt()).toISOString() },
        `Fomovoider's daily X ${kind} budget is used up`,
      );
    }
    return granted;
  }
}

function context(session: Session): CallContext {
  if (session.kind !== "oauth" || session.platform !== "x") {
    throw new ConnectorFailure({ kind: "session_expired" }, "X Chat needs an X OAuth session; log in to X again");
  }
  return { session: session as OAuthSession };
}

function isoFromMs(ms: number | undefined): ISODate | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

function compareVersions(a: string, b: string): number {
  return eventSortKey(a) < eventSortKey(b) ? -1 : eventSortKey(a) > eventSortKey(b) ? 1 : 0;
}
