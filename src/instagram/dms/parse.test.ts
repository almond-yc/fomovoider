import { describe, expect, test } from "vitest";
import inbox from "./__fixtures__/dm-inbox.json";
import sendError from "./__fixtures__/dm-send-error.json";
import detail from "./__fixtures__/dm-thread-detail.json";
import { emptyCapture, parseDeltas, parseInbox, parseSendResponse, parseThreadDetail } from "./parse";

// Fixtures: redacted captures from the FOMO-23 spike (instagram.com in a
// WKWebView, 2026-11-15). Only fields the parsers read are kept; every name,
// text, id and URL is replaced.

// A lightspeed payload as the socket hook forwards it: protobuf framing
// bytes around the JSON. The reaction and receipt deltas mirror captured
// ones; the message delta is synthesized (none arrived during the spike).
function payload(deltas: unknown[]) {
  return "\n\u0002\u0006\u0000\u0012\u00d6\u0003\u001a" + JSON.stringify([{ data: { slide_delta_processor: deltas } }]) + "\u0000";
}

describe("instagram dm parsers", () => {
  test("inbox: Primary threads with members, thread keys, previews and unread counts", () => {
    const out = parseInbox(inbox);
    expect(out.seqIds).toEqual([19888]);
    expect(out.viewerIds.length).toBeGreaterThan(0);
    expect(out.threads).toHaveLength(4);
    for (const t of out.threads) {
      expect(t.id).toMatch(/^instagram:\d+$/);
      expect(t.threadKey).toMatch(/^\d+$/);
      expect(t.members.length).toBeGreaterThan(0);
      expect(t.members[0].person.id).toMatch(/^instagram:/);
      expect(Date.parse(t.updatedAt)).toBeGreaterThan(0);
    }
    const oneToOne = out.threads.find((t) => !t.isGroup)!;
    expect(oneToOne.title).toBeUndefined();
    expect(oneToOne.threadKey).not.toBe(oneToOne.id.slice("instagram:".length));
    expect(out.threads.find((t) => t.isGroup)?.title).toMatch(/^Name/);
    expect(out.messages.length).toBeGreaterThan(10);
    expect(out.messages.every((m) => m.text || m.media.length)).toBe(true);
    expect(out.messages.every((m) => out.threads.some((t) => t.id === m.conversationId))).toBe(true);
  });

  test("thread detail: text, images, video, gif and sticker messages; reaction logs skipped", () => {
    const out = parseThreadDetail(detail);
    expect(out.threads).toEqual([]);
    const kinds = new Set(out.messages.flatMap((m) => m.media.map((x) => x.kind)));
    expect(kinds).toEqual(new Set(["image", "video", "gif"]));
    const video = out.messages.flatMap((m) => m.media).find((x) => x.kind === "video")!;
    expect(video.url).toMatch(/\.mp4/);
    expect(out.messages.some((m) => m.text && !m.media.length)).toBe(true);
    expect(out.senders.length).toBeGreaterThan(0);
    expect(out.receipts.length).toBeGreaterThan(0);
  });

  test("deltas: new message, read receipt and sequence ids; reactions ignored; unknown types flag the thread", () => {
    const out = parseDeltas(
      payload([
        {
          __typename: "SlideUQPPCreateReaction",
          uq_seq_id: "19889",
          thread_fbid: "1000000000007919",
          message_id: "mid.$1",
          reaction: { reaction: "\u2764", sender_fbid: "100000000023757" },
        },
        {
          __typename: "SlideUQPPNewMessage",
          uq_seq_id: "19890",
          thread_fbid: "1000000000007919",
          message: { message_id: "mid.$2", timestamp_ms: "1794786600000", sender_fbid: "100000000023757", content_type: "TEXT", text_body: "hi" },
        },
        { __typename: "SlideUQPPReadReceipt", uq_seq_id: "19891", thread_fbid: "1000000000007919", participant_fbid: "1", watermark_timestamp_ms: "1794786600001" },
        { __typename: "SlideUQPPSomethingNew", uq_seq_id: "19892", thread_fbid: "42" },
      ]),
      emptyCapture(),
    );
    expect(out.seqIds).toEqual([19889, 19890, 19891, 19892]);
    expect(out.messages).toEqual([
      {
        id: "instagram:mid.$2",
        conversationId: "instagram:1000000000007919",
        senderFbid: "100000000023757",
        sentAt: new Date(1794786600000).toISOString(),
        text: "hi",
        media: [],
      },
    ]);
    expect(out.receipts).toEqual([{ conversationId: "instagram:1000000000007919", participantFbid: "1", watermark: 1794786600001 }]);
    expect(out.changed).toEqual(["instagram:42"]);
  });

  test("send response: the captured 1675030 failure reads as an error", () => {
    expect(parseSendResponse(sendError)).toEqual({
      ok: false,
      error: "Instagram didn't send this message (error 1675030). Open the chat in Instagram to check.",
    });
    expect(
      parseSendResponse({
        data: { xig_direct_text_send_with_slide_messaging_response: { message_id: "mid.$9", timestamp_ms: "1794786600000" } },
      }),
    ).toEqual({ ok: true, messageId: "instagram:mid.$9", sentAt: new Date(1794786600000).toISOString() });
  });
});
