import type { Conversation, Message, Person, Post } from "../types";
import type { XIncludes, XTweet, XUrlEntity, XUser } from "./api-types";
import { chatConversationId, eventSortKey } from "./chat/ids";

const TWITTER_EPOCH_MS = 1288834974657n;
import { LOCKED } from "./chat/client";
import { API_BASE, paths } from "./endpoints";
import { cleanText, XMapper, xId } from "./mappers";

// X Activity API (XAA) events delivered to our webhook. See
// convex/x/README.md, "Webhooks".

// What each account subscribes to. oauth.revoke needs no subscription.
export const WEBHOOK_EVENTS = ["dm.received", "dm.sent", "chat.received", "chat.sent", "post.mention.create"] as const;

// Billed per delivered event; the rest are free.
export const BILLED_EVENTS: ReadonlySet<string> = new Set(["dm.received", "chat.received", "post.mention.create"]);

export interface ActivityEvent {
  event_uuid: string;
  created_at?: string;
  event_type: string;
  filter?: { user_id?: string };
  tag?: string;
  payload: unknown;
  includes?: XIncludes;
}

// The X user an event belongs to: the subscription's user, or the user who
// revoked the app.
export function activityUserId(event: ActivityEvent): string | undefined {
  if (event.event_type === "oauth.revoke") return (event.payload as { user_id?: string } | undefined)?.user_id;
  return event.filter?.user_id;
}

// A webhook POST body holds one event under data (an array is accepted too).
export function parseActivity(body: unknown): ActivityEvent[] {
  const data = (body as { data?: unknown } | null)?.data;
  const events = Array.isArray(data) ? data : data ? [data] : [];
  return events.filter((e): e is ActivityEvent => typeof e?.event_uuid === "string" && typeof e?.event_type === "string");
}

// "sha256=" + base64(HMAC-SHA256(secret, message)), the format of both the
// CRC response_token and the signature header.
export async function signWebhook(secret: string, message: string | ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const data = typeof message === "string" ? new TextEncoder().encode(message) : new Uint8Array(message);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return `sha256=${btoa(String.fromCharCode(...mac))}`;
}

// Checks X-Twitter-Webhooks-Signature-OAuth2 over the raw body, in constant time.
export async function verifyWebhook(secret: string, body: ArrayBuffer, header: string | null): Promise<boolean> {
  if (!header) return false;
  const expected = await signWebhook(secret, body);
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

interface XLegacyDmEvent {
  type: string;
  id: string;
  created_timestamp: string;
  message_create?: {
    target: { recipient_id: string };
    sender_id: string;
    message_data: { text?: string; entities?: { urls?: XUrlEntity[] } };
  };
}

interface XDmActivity {
  direct_message_events?: XLegacyDmEvent[];
  users?: Record<string, { data?: XUser } | XUser>;
}

// dm.received / dm.sent: legacy (v1.1-shaped) DM events plus the people in
// them, as contract messages with their conversation.
export function dmActivity(payload: unknown, meId: string): { message: Message; conversation: Conversation }[] {
  const { direct_message_events: events = [], users = {} } = (payload ?? {}) as XDmActivity;
  const people = Object.values(users).map((u) => ("data" in u && u.data ? u.data : (u as XUser))).filter((u) => u?.id);
  const mapper = new XMapper(undefined, people);
  return events.flatMap((e) => {
    const create = e.message_create;
    if (e.type !== "message_create" || !create) return [];
    const conversationId = chatConversationId(`${create.sender_id}-${create.target.recipient_id}`);
    const sentAt = new Date(Number(e.created_timestamp)).toISOString();
    const message: Message = {
      id: xId(e.id),
      conversationId,
      sender: mapper.person(create.sender_id),
      isMine: create.sender_id === meId,
      sentAt,
      text: cleanText(create.message_data.text ?? "", create.message_data.entities?.urls),
      media: [],
      raw: e,
    };
    const others = [...new Set([create.sender_id, create.target.recipient_id])].filter((id) => id !== meId);
    return [{ message, conversation: { id: conversationId, platform: "x", participants: others.map((id) => mapper.person(id)), lastMessage: message, updatedAt: sentAt } }];
  });
}

interface XChatActivity {
  id: string;
  conversation_id: string;
  created_at_msec?: string;
  sender_id?: string;
  conversation_key_version?: string;
  encoded_event: string;
  conversation_key_change_event?: string;
}

// encoded_event starts with the event's sequence id (Thrift field 1, a
// string): the id GET /2/chat/conversations/{id}/events returns for the same
// event. Keying webhook rows by it keeps one row per event whichever path
// stored it, in order, with edit targets that resolve.
export function chatSequenceId(encodedEvent: string): string | undefined {
  try {
    const bytes = Uint8Array.from(atob(encodedEvent.slice(0, 40)), (c) => c.charCodeAt(0));
    if (bytes[0] !== 0x0b || bytes[1] !== 0 || bytes[2] !== 1) return undefined;
    const length = (bytes[3]! << 24) | (bytes[4]! << 16) | (bytes[5]! << 8) | bytes[6]!;
    if (length < 1 || length > 19) return undefined;
    const id = String.fromCharCode(...bytes.slice(7, 7 + length));
    return /^\d+$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

// chat.received / chat.sent: one encrypted event, stored as ciphertext, and
// its conversation as a locked inbox row (participants are filled by the X
// Chat sync). sortKey orders it with polled rows: the sequence id, or else a
// snowflake built from the event time.
export function chatActivity(payload: unknown, meId: string) {
  const p = payload as XChatActivity;
  const conversationId = chatConversationId(p.conversation_id.replace(":", "-"));
  const createdMs = p.created_at_msec ? Number(p.created_at_msec) : Date.now();
  const createdAt = p.created_at_msec ? new Date(createdMs).toISOString() : undefined;
  const sequenceId = chatSequenceId(p.encoded_event);
  const sortKey = eventSortKey(sequenceId ?? String((BigInt(createdMs) - TWITTER_EPOCH_MS) << 22n));
  const others = conversationId.startsWith("x:g") ? [] : conversationId.slice(2).split("-").filter((id) => id !== meId);
  const participants: Person[] = [...new Set(others)].map((id) => ({ id: xId(id), platform: "x", handle: "", displayName: "" }));
  return {
    conversation: { id: conversationId, platform: "x", participants, unavailable: LOCKED, updatedAt: new Date(createdMs).toISOString() } satisfies Conversation,
    sortKey,
    event: {
      id: sequenceId ?? p.id,
      encodedEvent: p.encoded_event,
      ...(p.conversation_key_version ? { keyVersion: p.conversation_key_version } : {}),
      ...(p.sender_id ? { senderId: p.sender_id } : {}),
      ...(createdAt ? { createdAt } : {}),
    },
    ...(p.conversation_key_change_event ? { keyEvent: p.conversation_key_change_event } : {}),
  };
}

// post.mention.create: a v2 post with its includes.
export function mentionActivity(event: ActivityEvent): Post {
  return new XMapper(event.includes).post(event.payload as XTweet);
}

interface AppAuth {
  bearerToken: string;
  fetch?: typeof fetch;
}

// Calls X with the app-only bearer token (webhook management, and cleanup of
// subscriptions whose user token is gone).
function appCall(opts: AppAuth) {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  return async <T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T> => {
    const res = await doFetch(`${API_BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${opts.bearerToken}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok && !okStatuses.includes(res.status)) throw new Error(`X ${method} ${path} failed: HTTP ${res.status} ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  };
}

export interface ActivitySubscription {
  subscription_id: string;
  event_type: string;
  webhook_id?: string;
}

// One X user's subscriptions, with the app token.
export async function listSubscriptions(opts: AppAuth & { userId: string }): Promise<ActivitySubscription[]> {
  const res = await appCall(opts)<{ data?: ActivitySubscription[] }>("GET", `${paths.activitySubscriptions}?user_id=${encodeURIComponent(opts.userId)}`);
  return res.data ?? [];
}

// Deletes subscriptions with the app token; ones already gone are skipped.
export async function deleteSubscriptions(opts: AppAuth & { ids: string[] }): Promise<void> {
  const call = appCall(opts);
  for (const id of opts.ids) await call("DELETE", paths.activitySubscription(id), undefined, [404]);
}

export interface WebhookConfig {
  id: string;
  url: string;
  valid: boolean;
}

// Registers url as the app's webhook with the app-only bearer token, or
// returns the existing registration (revalidated with a CRC if X marked it
// invalid). X sends a CRC to url before answering, so the route must be live.
export async function registerWebhook(opts: AppAuth & { url: string }): Promise<WebhookConfig> {
  const call = appCall(opts);
  const listed = await call<{ data?: WebhookConfig[] }>("GET", "/2/webhooks?webhook_config.fields=id,url,valid,created_at");
  const existing = listed.data?.find((w) => w.url === opts.url);
  if (existing?.valid) return existing;
  if (existing) {
    await call("PUT", `/2/webhooks/${existing.id}`);
    return { ...existing, valid: true };
  }
  const created = await call<{ data: WebhookConfig }>("POST", "/2/webhooks", { url: opts.url });
  return created.data;
}

