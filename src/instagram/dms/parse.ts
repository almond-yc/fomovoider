import { person, type Person } from "../parse";

// Parsers for the Instagram DM data the hidden instagram.com web view sees
// passively on /direct/: the Primary inbox (PolarisDirectInboxMobileQuery,
// the last 5 messages of 15 threads), the thread histories the page
// prefetches on its own (IGDThreadDetailQuery, 20 messages each), realtime
// deltas from the lightspeed WebSocket, and the page's own send mutation
// response. Ids follow the contract: conversations are
// instagram:<thread_fbid>, messages instagram:<message_id>.

type Json = any;

export interface DmMedia {
  kind: "image" | "video" | "gif";
  url: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  altText?: string;
}

export interface DmMember {
  fbid: string;
  person: Person;
}

export interface DmThread {
  id: string;
  // The id in the thread's own URL, /direct/t/<threadKey>/.
  threadKey: string;
  title?: string;
  isGroup: boolean;
  members: DmMember[];
  updatedAt: string;
  unreadCount: number;
}

export interface DmMessage {
  id: string;
  conversationId: string;
  senderFbid: string;
  sentAt: string;
  text: string;
  media: DmMedia[];
}

export interface DmReceipt {
  conversationId: string;
  participantFbid: string;
  watermark: number;
}

export interface DmViewer {
  handle: string;
  fbid: string;
}

export interface DmCapture {
  // Who the page is logged in as, from a thread's viewer (thread details carry
  // the username). DM data is only kept once this matches the account.
  viewer?: DmViewer;
  // The viewer's messaging ids (the user fbid and the mailbox id); a sender
  // or receipt with one of them is the viewer.
  viewerIds: string[];
  threads: DmThread[];
  messages: DmMessage[];
  // Senders seen on messages, so a group member who isn't in users[] still
  // gets a name.
  senders: DmMember[];
  receipts: DmReceipt[];
  // The Iris sync sequence ids: the inbox's iris_inactive_subscription_uq_seq_id
  // and each delta's uq_seq_id.
  seqIds: number[];
  // Conversations a delta changed in a way these parsers don't read; an
  // inbox reload picks up the change.
  changed: string[];
}

export type SendOutcome = { ok: true; messageId?: string; sentAt?: string } | { ok: false; error: string };

export const INBOX_OPERATION = "PolarisDirectInboxMobileQuery";
export const THREAD_OPERATION = "IGDThreadDetailQuery";
export const SEND_OPERATION = "IGDirectTextSendMutation";
export const MARK_READ_OPERATION = "useIGDMarkThreadAsReadMutation";
// GraphQL operations the DM plug-in asks the host to capture.
export const DM_OPERATIONS = [INBOX_OPERATION, THREAD_OPERATION, SEND_OPERATION, MARK_READ_OPERATION];

export const conversationId = (threadFbid: string | number) => "instagram:" + threadFbid;

export function emptyCapture(): DmCapture {
  return { viewerIds: [], threads: [], messages: [], senders: [], receipts: [], seqIds: [], changed: [] };
}

function* findKey(value: Json, key: string): Generator<Json> {
  if (Array.isArray(value)) {
    for (const item of value) yield* findKey(item, key);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === key && v) yield v;
      yield* findKey(v, key);
    }
  }
}

const iso = (ms: number) => new Date(ms).toISOString();
const str = (value: unknown) => (value === undefined || value === null ? "" : String(value));

function size(width: unknown, height: unknown) {
  return {
    ...(typeof width === "number" ? { width } : {}),
    ...(typeof height === "number" ? { height } : {}),
  };
}

function attachmentMedia(a: Json): DmMedia[] {
  const preview = a?.preview_cdn_url ? String(a.preview_cdn_url) : undefined;
  const url = a?.attachment_cdn_url ?? a?.attachment_cdn_fallback_url ?? preview;
  if (!url) return [];
  const dims = size(a.preview_width, a.preview_height);
  const isVideo = /\.mp4(\?|$)/.test(String(url)) || /Video/.test(str(a.__typename));
  return isVideo
    ? [{ kind: "video", url: String(url), ...(preview ? { previewUrl: preview } : {}), ...dims }]
    : [{ kind: "image", url: String(url), ...dims }];
}

function gifMedia(a: Json): DmMedia[] {
  const url = a?.attachment_mp4_url ?? a?.attachment_webp_url ?? a?.preview_cdn_url;
  if (!url) return [];
  return [
    {
      kind: "gif",
      url: String(url),
      ...(a.preview_cdn_url ? { previewUrl: String(a.preview_cdn_url) } : {}),
      ...(a.alt_text ? { altText: String(a.alt_text) } : {}),
      ...size(a.preview_width, a.preview_height),
    },
  ];
}

// One SlideMessage node, or undefined for nodes Instagram doesn't show as a
// message bubble (reaction logs) and nodes with nothing to show.
export function parseMessage(node: Json, fallbackConversation?: string): DmMessage | undefined {
  const messageId = node?.message_id ?? node?.id;
  const ts = Number(node?.timestamp_ms);
  const thread = node?.thread_fbid ? conversationId(node.thread_fbid) : fallbackConversation;
  if (!messageId || !ts || !thread || node?.sender_fbid === undefined || node.sender_fbid === null) return undefined;
  const type = str(node.content_type);
  if (type === "REACTION_LOG_XMAT") return undefined;
  const content = node.content ?? {};
  const body = str(node.text_body ?? content.text_body).trim();
  let text = body;
  let attached: DmMedia[] = [];
  if (type.endsWith("_XMAT")) {
    text = (content.text_fragments ?? []).map((f: Json) => str(f?.plaintext)).join("").trim() || body;
  } else if (Array.isArray(content.attachments) || Array.isArray(content.ordered_photo_video_attachments)) {
    attached = (content.attachments ?? content.ordered_photo_video_attachments).flatMap(attachmentMedia);
  } else if (Array.isArray(content.animated_media)) {
    attached = content.animated_media.flatMap(gifMedia);
  } else if (content.preview_url) {
    attached = [{ kind: "image", url: String(content.preview_url), ...size(content.preview_width, content.preview_height) }];
  } else if (content.xma) {
    const xma = content.xma;
    text = [str(content.xma_text_body).trim() || body, str(xma.title_text ?? xma.caption_body_text).trim(), str(xma.target_url)]
      .filter((part, i, all) => part && all.indexOf(part) === i)
      .join("\n");
  }
  if (!text && !attached.length) text = str(node.igd_snippet).trim() || (type.startsWith("RAVEN") ? "Sent a disappearing message" : "");
  if (!text && !attached.length) return undefined;
  return {
    id: "instagram:" + messageId,
    conversationId: thread,
    senderFbid: str(node.sender_fbid),
    sentAt: iso(ts),
    text,
    media: attached,
  };
}

function senderOf(node: Json): DmMember | undefined {
  const user = node?.sender?.user_dict;
  if (!user?.username || !node.sender_fbid) return undefined;
  return { fbid: str(node.sender_fbid), person: person(user) };
}

// Primary inbox only: Requests and General threads are left out.
function isPrimary(thread: Json) {
  return thread.system_folder === "INBOX" && (thread.folder === undefined || thread.folder === null || thread.folder === "PRIMARY");
}

function readThread(t: Json, out: DmCapture, withThread: boolean) {
  const id = conversationId(t.thread_fbid ?? t.id);
  const viewerFbid = str(t.viewer?.interop_messaging_user_fbid);
  if (viewerFbid && !out.viewerIds.includes(viewerFbid)) out.viewerIds.push(viewerFbid);
  if (viewerFbid && t.viewer?.username) out.viewer ??= { handle: String(t.viewer.username), fbid: viewerFbid };
  const messages: DmMessage[] = [];
  for (const edge of t.slide_messages?.edges ?? []) {
    const message = parseMessage(edge?.node, id);
    if (message) messages.push(message);
    const sender = senderOf(edge?.node);
    if (sender) out.senders.push(sender);
  }
  out.messages.push(...messages);
  const receipts: DmReceipt[] = (t.slide_read_receipts ?? [])
    .filter((r: Json) => r?.participant_fbid && r.watermark_timestamp_ms)
    .map((r: Json) => ({ conversationId: id, participantFbid: str(r.participant_fbid), watermark: Number(r.watermark_timestamp_ms) }));
  out.receipts.push(...receipts);
  if (!withThread) return;
  const viewer = new Set(out.viewerIds);
  const watermark = Math.max(0, ...receipts.filter((r) => viewer.has(r.participantFbid)).map((r) => r.watermark));
  const unseen = messages.filter((m) => !viewer.has(m.senderFbid) && Date.parse(m.sentAt) > watermark).length;
  out.threads.push({
    id,
    threadKey: str(t.thread_key ?? t.thread_fbid),
    ...(t.is_group && t.thread_title ? { title: String(t.thread_title) } : {}),
    isGroup: Boolean(t.is_group),
    members: (t.users ?? [])
      .filter((u: Json) => u?.username)
      .map((u: Json) => ({ fbid: str(u.interop_messaging_user_fbid), person: person(u) })),
    updatedAt: iso(Number(t.last_activity_timestamp_ms) || Math.max(0, ...messages.map((m) => Date.parse(m.sentAt)))),
    unreadCount: unseen || (t.marked_as_unread ? 1 : 0),
  });
}

// PolarisDirectInboxMobileQuery: the Primary inbox page.
export function parseInbox(doc: Json, out: DmCapture = emptyCapture()) {
  for (const mailbox of findKey(doc, "get_slide_mailbox_for_iris_subscription")) {
    if (mailbox.id && !out.viewerIds.includes(str(mailbox.id))) out.viewerIds.push(str(mailbox.id));
    const seq = Number(mailbox.iris_inactive_subscription_uq_seq_id);
    if (seq) out.seqIds.push(seq);
    const seen = new Set(out.threads.map((t) => t.id));
    for (const key of ["threads_by_folder", "threads_by_system_folder_and_ig_inbox_folder", "pinned_threads_v2"]) {
      const list = mailbox[key];
      for (const edge of Array.isArray(list) ? list : list?.edges ?? []) {
        const t = edge?.node?.as_ig_direct_thread ?? edge?.as_ig_direct_thread;
        if (!t?.thread_fbid || !isPrimary(t) || seen.has(conversationId(t.thread_fbid))) continue;
        seen.add(conversationId(t.thread_fbid));
        readThread(t, out, true);
      }
    }
  }
  return out;
}

// IGDThreadDetailQuery: one thread's latest messages. Only its messages and
// receipts are read; the inbox decides which threads exist.
export function parseThreadDetail(doc: Json, out: DmCapture = emptyCapture()) {
  for (const wrapper of findKey(doc, "get_slide_thread_nullable")) {
    const t = wrapper.as_ig_direct_thread;
    if (t?.thread_fbid || t?.id) readThread(t, out, false);
  }
  return out;
}

// The first complete JSON array or object in text at or after from.
export function firstJson(text: string, from = 0): Json | undefined {
  for (let start = Math.max(0, from); start < text.length; start++) {
    if (text[start] !== "[" && text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") {
        if (--depth > 0) continue;
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

// One decoded lightspeed payload: a small protobuf wrapper around a JSON
// array of { data: { slide_delta_processor: [delta, ...] } }.
export function parseDeltas(payload: string, out: DmCapture = emptyCapture()) {
  const doc = firstJson(payload, payload.indexOf('[{"data"'));
  for (const deltas of findKey(doc, "slide_delta_processor")) {
    for (const d of Array.isArray(deltas) ? deltas : [deltas]) readDelta(d, out);
  }
  return out;
}

function readDelta(d: Json, out: DmCapture) {
  const seq = Number(d?.uq_seq_id);
  if (seq) out.seqIds.push(seq);
  const type = str(d?.__typename);
  const thread = d?.thread_fbid ? conversationId(d.thread_fbid) : undefined;
  if (/ReadReceipt/.test(type)) {
    if (thread && d.participant_fbid && d.watermark_timestamp_ms) {
      out.receipts.push({ conversationId: thread, participantFbid: str(d.participant_fbid), watermark: Number(d.watermark_timestamp_ms) });
    }
    return;
  }
  // Reactions and typing have no place in the contract's Message.
  if (/Reaction|Typing/.test(type)) return;
  const node = [d?.message?.node, d?.message, d?.slide_message, d].find(
    (n) => n && typeof n === "object" && n.timestamp_ms && n.sender_fbid !== undefined && (n.message_id || n.content_type),
  );
  const message = node ? parseMessage(node, thread) : undefined;
  if (message) {
    out.messages.push(message);
    const sender = senderOf(node);
    if (sender) out.senders.push(sender);
  } else if (thread && !out.changed.includes(thread)) {
    out.changed.push(thread);
  }
}

// The page's own IGDirectTextSendMutation response.
export function parseSendResponse(doc: Json): SendOutcome {
  const result = doc?.data?.xig_direct_text_send_with_slide_messaging_response;
  if (!result) {
    const code = doc?.errors?.[0]?.code;
    return {
      ok: false,
      error: `Instagram didn't send this message${code ? ` (error ${code})` : ""}. Open the chat in Instagram to check.`,
    };
  }
  const messageId = [...findKey(result, "message_id")][0];
  const ts = Number([...findKey(result, "timestamp_ms")][0]);
  return { ok: true, ...(messageId ? { messageId: "instagram:" + messageId } : {}), ...(ts ? { sentAt: iso(ts) } : {}) };
}
