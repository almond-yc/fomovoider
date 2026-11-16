import type { ConnectorError } from "../connectors/types";
import type { ChatConversation, ChatMessage } from "./types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const PLATFORM_NAMES: Record<string, string> = {
  x: "X",
  instagram: "Instagram",
};

export function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform.charAt(0).toUpperCase() + platform.slice(1);
}

export function conversationTitle(conversation: Pick<ChatConversation, "title" | "participants">): string {
  if (conversation.title) return conversation.title;
  const names = conversation.participants.map((p) => p.displayName || `@${p.handle}`);
  return names.join(", ") || "Conversation";
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function calendarDaysBetween(earlier: number, later: number): number {
  return Math.round((startOfDay(later) - startOfDay(earlier)) / DAY);
}

// Inbox timestamps: "now", "5m", "3h", then "Yesterday", a weekday, or a date.
export function relativeTime(ms: number, now: number, locale?: string): string {
  const diff = now - ms;
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  const days = calendarDaysBetween(ms, now);
  if (days === 0) return `${Math.floor(diff / HOUR)}h`;
  if (days === 1) return "Yesterday";
  if (days < 7) return new Date(ms).toLocaleDateString(locale, { weekday: "short" });
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString(locale, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

export function dayLabel(ms: number, now: number, locale?: string): string {
  const days = calendarDaysBetween(ms, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return new Date(ms).toLocaleDateString(locale, { weekday: "long" });
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function messageTime(ms: number, locale?: string): string {
  return new Date(ms).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

export type ThreadItem =
  | { kind: "message"; key: string; message: ChatMessage }
  | { kind: "day"; key: string; label: string };

// Messages newest first, with a day separator after the oldest message of
// each day, so an inverted list shows it above that day's messages.
export function withDaySeparators(messages: ChatMessage[], now: number, locale?: string): ThreadItem[] {
  const items: ThreadItem[] = [];
  messages.forEach((message, i) => {
    items.push({ kind: "message", key: message.id, message });
    const older = messages[i + 1];
    if (!older || startOfDay(older.sentAt) !== startOfDay(message.sentAt)) {
      const day = startOfDay(message.sentAt);
      items.push({ kind: "day", key: `day:${day}`, label: dayLabel(message.sentAt, now, locale) });
    }
  });
  return items;
}

// Conversations from every source, newest first, one row per id (the later source wins).
export function mergeConversations(...sources: (ChatConversation[] | undefined)[]): ChatConversation[] {
  const byId = new Map<string, ChatConversation>();
  for (const source of sources) for (const c of source ?? []) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function unavailableText(reason: string, platform: string): string {
  const name = platformName(platform);
  switch (reason) {
    case "encrypted":
      return `Encrypted chat. Open it in ${name}.`;
    case "locked":
      return `Encrypted. Unlock ${name} Chat to read.`;
    case "unsupported":
      return `Fomovoider can't show this chat yet. Open it in ${name}.`;
    default:
      return `Can't be shown here (${reason}).`;
  }
}

function clock(iso: string | undefined, locale?: string): string | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : messageTime(ms, locale);
}

// What the user sees when messages.send returns a ConnectorError.
export function sendErrorText(error: ConnectorError, platform: string, locale?: string): string {
  const name = platformName(platform);
  switch (error.kind) {
    case "session_expired":
      return `Your ${name} account needs reconnecting before you can send.`;
    case "rate_limited": {
      const at = clock(error.retryAt, locale);
      return at ? `${name} is limiting messages. Try again after ${at}.` : `${name} is limiting messages. Try again in a few minutes.`;
    }
    case "budget_exhausted": {
      const at = clock(error.resetsAt, locale);
      return at
        ? `Today's ${name} sending allowance is used up. It resets at ${at}.`
        : `Today's ${name} sending allowance is used up. It resets tomorrow.`;
    }
    case "unsupported":
      return error.capability === "sendMedia"
        ? `Photos and videos can't be sent to ${name} yet.`
        : `Fomovoider can't send to this ${name} chat yet.`;
    case "network":
      return `Couldn't reach ${name}. Check your connection.`;
    case "platform":
      return error.message;
  }
}

// A platform's clock may put a confirmed send slightly before the moment the
// server accepted it.
const SEND_CLOCK_SKEW_MS = 10_000;

// Optimistic sends still to show. A send the server accepted keeps its bubble
// until its stored row arrives, so the message never shows twice and never
// blinks out between the action returning and the list updating. The row is
// found by the id the send returned or, for a platform that renames the row
// once delivered (Instagram swaps in its own id), by an own row with the same
// text sent at or after that time that no other bubble already matched.
export function unconfirmedPending<P extends { sent?: Pick<ChatMessage, "id" | "text" | "sentAt"> }>(
  pending: P[],
  messages: Pick<ChatMessage, "id" | "isMine" | "text" | "sentAt">[] | null,
): P[] {
  if (!messages) return pending;
  const ids = new Set(messages.map((m) => m.id));
  const claimed = new Set(pending.flatMap((p) => (p.sent && ids.has(p.sent.id) ? [p.sent.id] : [])));
  return pending.filter(({ sent }) => {
    if (!sent) return true;
    if (ids.has(sent.id)) return false;
    const renamed = messages.find(
      (m) => m.isMine && !claimed.has(m.id) && m.text === sent.text && m.sentAt >= sent.sentAt - SEND_CLOCK_SKEW_MS,
    );
    if (!renamed) return true;
    claimed.add(renamed.id);
    return false;
  });
}
