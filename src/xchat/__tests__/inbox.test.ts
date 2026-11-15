import { describe, expect, it } from "vitest";
import type { Message, Person } from "../../connectors/types";
import { chatMessages } from "../../connectors/x/chat";
import { isLockedXChat, toInboxMessage, unlockedInboxRow } from "../inbox";

const alice: Person = { id: "x:1001", platform: "x", handle: "alice", displayName: "Alice" };
const message: Message = { id: "x:e1", conversationId: "x:1001-2002", sender: alice, isMine: false, sentAt: "2026-11-15T18:30:00.000Z", text: "hi", media: [], raw: { secret: 1 } };
const row = { _id: "abc", id: "x:1001-2002", platform: "x" as const, participants: [alice], unavailable: { reason: "locked" }, updatedAt: Date.parse("2026-11-15T18:00:00.000Z") };

describe("X Chat inbox rows", () => {
  it("converts decrypted messages to the epoch-ms shape Convex queries return, without raw", () => {
    expect(toInboxMessage(message)).toEqual({ id: "x:e1", conversationId: "x:1001-2002", sender: alice, isMine: false, sentAt: Date.parse("2026-11-15T18:30:00.000Z"), text: "hi", media: [] });
  });

  it("unlocks a locked row with its newest message and keeps the row's other fields", () => {
    expect(isLockedXChat(row)).toBe(true);
    const unlocked = unlockedInboxRow(row, [toInboxMessage(message)]);
    expect(isLockedXChat(unlocked)).toBe(false);
    expect(unlocked).toMatchObject({ _id: "abc", lastMessage: { text: "hi" }, updatedAt: Date.parse("2026-11-15T18:30:00.000Z") });
    expect(unlockedInboxRow(row, [])).not.toHaveProperty("unavailable");
  });
});

describe("decrypted edits", () => {
  it("apply oldest first, so the latest edit wins with rows in any order", () => {
    const rows = [
      { id: "3", encodedEvent: "e3", createdAt: "2026-11-15T18:03:00.000Z" },
      { id: "2", encodedEvent: "e2", createdAt: "2026-11-15T18:02:00.000Z" },
      { id: "1", encodedEvent: "e1", createdAt: "2026-11-15T18:01:00.000Z" },
    ];
    const outcomes = [
      { event: { type: "message", senderId: "1001", content: { contentType: "edit", targetMessageSequenceId: "1", updatedText: "second edit" } } },
      { event: { type: "message", senderId: "1001", content: { contentType: "edit", targetMessageSequenceId: "1", updatedText: "first edit" } } },
      { event: { type: "message", senderId: "1001", content: { contentType: "text", text: "original" } } },
    ];
    const ctx = { conversationId: "x:1001-2002" as const, meId: "2002", people: new Map([["1001", alice]]) };
    expect(chatMessages(rows, outcomes, ctx)[0]!.text).toBe("second edit");
    expect(chatMessages([...rows].reverse(), [...outcomes].reverse(), ctx)[0]!.text).toBe("second edit");
  });
});
