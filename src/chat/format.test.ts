import { describe, expect, test } from "vitest";
import {
  conversationTitle,
  dayLabel,
  mergeConversations,
  relativeTime,
  sendErrorText,
  unavailableText,
  withDaySeparators,
} from "./format";
import type { ChatConversation, ChatMessage } from "./types";

const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const NOW = at(2026, 11, 15, 15, 0);

function message(id: string, sentAt: number): ChatMessage {
  return {
    id,
    conversationId: "x:c",
    sender: { id: "x:a", platform: "x", handle: "a", displayName: "A" },
    isMine: false,
    sentAt,
    text: id,
    media: [],
  };
}

function conversation(id: string, updatedAt: number, extra: Partial<ChatConversation> = {}): ChatConversation {
  return { id, platform: "x", participants: [], updatedAt, ...extra };
}

describe("relativeTime", () => {
  test("minutes and hours today, then yesterday, weekday and date", () => {
    expect(relativeTime(NOW - 20_000, NOW)).toBe("now");
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5m");
    expect(relativeTime(at(2026, 11, 15, 9), NOW)).toBe("6h");
    expect(relativeTime(at(2026, 11, 14, 23), NOW)).toBe("Yesterday");
    expect(relativeTime(at(2026, 11, 11), NOW, "en-US")).toBe("Wed");
    expect(relativeTime(at(2026, 10, 3), NOW, "en-US")).toBe("Oct 3");
    expect(relativeTime(at(2025, 10, 3), NOW, "en-US")).toBe("Oct 3, 2025");
  });
});

describe("withDaySeparators", () => {
  test("puts one separator after the oldest message of each day", () => {
    const items = withDaySeparators(
      [message("m3", at(2026, 11, 15, 10)), message("m2", at(2026, 11, 15, 9)), message("m1", at(2026, 11, 13, 9))],
      NOW,
      "en-US",
    );
    expect(items.map((i) => (i.kind === "day" ? i.label : i.message.id))).toEqual(["m3", "m2", "Today", "m1", "Friday"]);
    expect(dayLabel(at(2026, 11, 14), NOW)).toBe("Yesterday");
    expect(dayLabel(at(2026, 9, 1), NOW, "en-US")).toBe("Tue, Sep 1");
  });
});

describe("mergeConversations", () => {
  test("sorts every source together newest first and lets the later source replace a row", () => {
    const merged = mergeConversations(
      [conversation("x:a", 3), conversation("x:locked", 1, { unavailable: { reason: "locked" } })],
      [conversation("x:locked", 5), conversation("x:b", 4)],
    );
    expect(merged.map((c) => [c.id, c.unavailable?.reason])).toEqual([
      ["x:locked", undefined],
      ["x:b", undefined],
      ["x:a", undefined],
    ]);
    expect(mergeConversations(undefined, [conversation("x:a", 1)]).map((c) => c.id)).toEqual(["x:a"]);
  });
});

describe("copy", () => {
  test("titles fall back to participants", () => {
    const p = (displayName: string, handle: string) => ({ id: `x:${handle}`, platform: "x", handle, displayName });
    expect(conversationTitle({ title: "Climbing", participants: [] })).toBe("Climbing");
    expect(conversationTitle({ participants: [p("Ana", "ana"), p("", "mei")] })).toBe("Ana, @mei");
  });

  test("every ConnectorError has readable send copy", () => {
    expect(sendErrorText({ kind: "session_expired" }, "x")).toBe("Your X account needs reconnecting before you can send.");
    expect(sendErrorText({ kind: "rate_limited" }, "x")).toBe("X is limiting messages. Try again in a few minutes.");
    expect(sendErrorText({ kind: "rate_limited", retryAt: new Date(at(2026, 11, 15, 15, 40)).toISOString() }, "x", "en-US")).toBe(
      "X is limiting messages. Try again after 3:40 PM.",
    );
    expect(sendErrorText({ kind: "budget_exhausted" }, "x")).toBe("Today's X sending allowance is used up. It resets tomorrow.");
    expect(sendErrorText({ kind: "unsupported", capability: "sendMedia" }, "telegram")).toBe(
      "Photos and videos can't be sent to Telegram yet.",
    );
    expect(sendErrorText({ kind: "unsupported", capability: "sendMessage" }, "instagram")).toBe(
      "Fomovoider can't send to this Instagram chat yet.",
    );
    expect(sendErrorText({ kind: "network" }, "x")).toBe("Couldn't reach X. Check your connection.");
    expect(sendErrorText({ kind: "platform", message: "X refused the message" }, "x")).toBe("X refused the message");
    expect(unavailableText("encrypted", "x")).toBe("Encrypted chat. Open it in X.");
    expect(unavailableText("locked", "x")).toBe("Encrypted. Unlock X Chat to read.");
  });
});
