/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import inbox from "../../src/instagram/dms/__fixtures__/dm-inbox.json";
import { emptyCapture, parseInbox } from "../../src/instagram/dms/parse";

const modules = import.meta.glob("/convex/**/*.ts");
const me = { id: "instagram:nico", platform: "instagram", handle: "nico", displayName: "Nico" };

async function connected() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const as = t.withIdentity({ subject: `${userId}|session` });
  await as.mutation(api.instagram.webview.connect, { me });
  const accountId = (await t.run((ctx) =>
    ctx.db
      .query("connectedAccounts")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId).eq("platform", "instagram"))
      .unique(),
  ))!._id;
  return { t, userId, as, accountId };
}

async function submitInbox(as: Awaited<ReturnType<typeof connected>>["as"]) {
  const { seqIds: _s, changed: _c, ...capture } = parseInbox(inbox, emptyCapture());
  await as.mutation(api.instagram.dms.submit, capture);
  return capture;
}

const conversations = (t: Awaited<ReturnType<typeof connected>>["t"]) => t.run((ctx) => ctx.db.query("conversations").collect());
const messages = (t: Awaited<ReturnType<typeof connected>>["t"], conversationId: string) =>
  t.run((ctx) => ctx.db.query("messages").filter((q) => q.eq(q.field("conversationId"), conversationId)).collect());

describe("instagram dms", () => {
  test("the inbox lands in conversations and messages, with the viewer's own messages as Nico", async () => {
    const { t, as } = await connected();
    const capture = await submitInbox(as);
    const rows = await conversations(t);
    expect(rows).toHaveLength(4);
    const group = rows.find((c) => c.title)!;
    expect(group.participants.length).toBeGreaterThan(1);
    expect(group.lastMessage).toBeDefined();
    const stored = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(stored.length).toBe(new Set(capture.messages.map((m) => m.id)).size);
    const mine = stored.filter((m) => m.isMine);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((m) => m.sender.handle === "nico")).toBe(true);
    expect(stored.filter((m) => !m.isMine).every((m) => m.sender.handle.startsWith("user_") || m.sender.displayName)).toBe(true);
  });

  test("messages of threads outside the Primary inbox are dropped; a live message bumps unread", async () => {
    const { t, as } = await connected();
    const capture = await submitInbox(as);
    const thread = capture.threads[0];
    const before = (await conversations(t)).find((c) => c.id === thread.id)!;
    const other = thread.members[0];
    const base = { senders: [], receipts: [], threads: [], viewerIds: [] };
    await as.mutation(api.instagram.dms.submit, {
      ...base,
      messages: [
        { id: "instagram:mid.$new", conversationId: thread.id, senderFbid: other.fbid, sentAt: new Date(Date.now()).toISOString(), text: "hey", media: [], live: true },
        { id: "instagram:mid.$x", conversationId: "instagram:999", senderFbid: other.fbid, sentAt: new Date().toISOString(), text: "requests", media: [] },
      ],
    });
    const after = (await conversations(t)).find((c) => c.id === thread.id)!;
    expect(after.lastMessage?.text).toBe("hey");
    expect(after.unreadCount).toBe((before.unreadCount ?? 0) + 1);
    expect(await messages(t, "instagram:999")).toEqual([]);
    // A read receipt from the viewer (read in the Instagram app) clears it.
    await as.mutation(api.instagram.dms.submit, {
      ...base,
      messages: [],
      receipts: [{ conversationId: thread.id, participantFbid: capture.viewerIds[0], watermark: Date.now() + 1 }],
    });
    expect((await conversations(t)).find((c) => c.id === thread.id)!.unreadCount).toBe(0);
  });

  test("send: pending row, claimed by the phone, flipped to sent with Instagram's id; the captured copy doesn't duplicate it", async () => {
    vi.useFakeTimers();
    const { t, as, accountId } = await connected();
    const capture = await submitInbox(as);
    const conversationId = capture.threads[0].id;
    const sent = await t.mutation(internal.instagram.send.message, { accountId, conversationId, text: " got it " });
    expect(sent).toMatchObject({ isMine: true, text: "got it", delivery: { status: "pending" } });
    expect((await conversations(t)).find((c) => c.id === conversationId)!.lastMessage?.id).toBe(sent.id);

    const [item] = await as.query(api.instagram.dms.outbox, {});
    const task = await as.mutation(api.instagram.dms.claim, { outboxId: item.outboxId });
    expect(task).toEqual({ outboxId: item.outboxId, kind: "send", threadKey: capture.threads[0].threadKey, text: "got it" });
    expect(await as.mutation(api.instagram.dms.claim, { outboxId: item.outboxId })).toBeNull();
    expect(await as.query(api.instagram.dms.outbox, {})).toEqual([]);

    const sentAt = new Date(sent.sentAt + 500).toISOString();
    await as.mutation(api.instagram.dms.complete, { outboxId: item.outboxId, result: { ok: true, messageId: "instagram:mid.$sent", sentAt } });
    let rows = await messages(t, conversationId);
    const flipped = rows.find((m) => m.id === "instagram:mid.$sent")!;
    expect(flipped).toMatchObject({ delivery: { status: "sent" }, sentAt: Date.parse(sentAt), text: "got it" });
    expect(rows.some((m) => m.id === sent.id)).toBe(false);
    expect((await conversations(t)).find((c) => c.id === conversationId)!.lastMessage?.id).toBe("instagram:mid.$sent");

    // The socket's copy of the same message replaces it as delivered.
    await as.mutation(api.instagram.dms.submit, {
      viewerIds: [],
      threads: [],
      senders: [],
      receipts: [],
      messages: [{ id: "instagram:mid.$sent", conversationId, senderFbid: capture.viewerIds[0], sentAt, text: "got it", media: [], live: true }],
    });
    rows = (await messages(t, conversationId)).filter((m) => m.text === "got it");
    expect(rows).toHaveLength(1);
    expect(rows[0].delivery).toBeUndefined();
    vi.useRealTimers();
  });

  test("a failed send shows its error; an unconfirmed claim fails after the timeout", async () => {
    vi.useFakeTimers();
    const { t, as, accountId } = await connected();
    const capture = await submitInbox(as);
    const conversationId = capture.threads[1].id;
    const first = await t.mutation(internal.instagram.send.message, { accountId, conversationId, text: "one" });
    let [item] = await as.query(api.instagram.dms.outbox, {});
    await as.mutation(api.instagram.dms.claim, { outboxId: item.outboxId });
    await as.mutation(api.instagram.dms.complete, {
      outboxId: item.outboxId,
      result: { ok: false, error: "Instagram didn't send this message (error 1675030). Open the chat in Instagram to check." },
    });
    expect((await messages(t, conversationId)).find((m) => m.id === first.id)?.delivery).toEqual({
      status: "failed",
      error: "Instagram didn't send this message (error 1675030). Open the chat in Instagram to check.",
    });

    const second = await t.mutation(internal.instagram.send.message, { accountId, conversationId, text: "two" });
    [item] = await as.query(api.instagram.dms.outbox, {});
    await as.mutation(api.instagram.dms.claim, { outboxId: item.outboxId as Id<"instagram_outbox"> });
    vi.advanceTimersByTime(3 * 60_000 + 1);
    await t.finishInProgressScheduledFunctions();
    expect((await messages(t, conversationId)).find((m) => m.id === second.id)?.delivery?.status).toBe("failed");
    vi.useRealTimers();
  });

  test("sends refuse empty, long and unknown chats; markRead queues once and clears unread", async () => {
    const { t, as, accountId } = await connected();
    const capture = await submitInbox(as);
    const unread = capture.threads.find((th) => th.unreadCount > 0) ?? capture.threads[0];
    await expect(t.mutation(internal.instagram.send.message, { accountId, conversationId: unread.id, text: "  " })).rejects.toThrow();
    await expect(t.mutation(internal.instagram.send.message, { accountId, conversationId: unread.id, text: "x".repeat(1001) })).rejects.toThrow();
    await expect(t.mutation(internal.instagram.send.message, { accountId, conversationId: "instagram:1", text: "hi" })).rejects.toThrow();

    await t.run((ctx) =>
      ctx.db
        .query("conversations")
        .filter((q) => q.eq(q.field("id"), unread.id))
        .first()
        .then((c) => ctx.db.patch(c!._id, { unreadCount: 2 })),
    );
    await t.mutation(internal.instagram.send.markRead, { accountId, conversationId: unread.id });
    await t.mutation(internal.instagram.send.markRead, { accountId, conversationId: unread.id });
    const items = await as.query(api.instagram.dms.outbox, {});
    expect(items).toHaveLength(1);
    const task = await as.mutation(api.instagram.dms.claim, { outboxId: items[0].outboxId });
    expect(task).toEqual({ outboxId: items[0].outboxId, kind: "markRead", threadKey: unread.threadKey });
    await as.mutation(api.instagram.dms.complete, { outboxId: items[0].outboxId, result: { ok: true } });
    expect((await conversations(t)).find((c) => c.id === unread.id)!.unreadCount).toBe(0);
  });

  test("the kill switch blocks inbox loads and fails queued sends; syncs are spaced", async () => {
    const { t, as, accountId } = await connected();
    const capture = await submitInbox(as);
    expect(await as.mutation(api.instagram.dms.startSync, { trigger: "open" })).toEqual({ kind: "run" });
    expect((await as.mutation(api.instagram.dms.startSync, { trigger: "realtime" })).kind).toBe("wait");
    const sent = await t.mutation(internal.instagram.send.message, { accountId, conversationId: capture.threads[0].id, text: "hi" });
    const [item] = await as.query(api.instagram.dms.outbox, {});
    await t.mutation(internal.instagram.killSwitch.set, { enabled: true });
    expect(await as.mutation(api.instagram.dms.startSync, { trigger: "open" })).toMatchObject({ kind: "blocked" });
    expect(await as.query(api.instagram.dms.outbox, {})).toEqual([]);
    expect(await as.mutation(api.instagram.dms.claim, { outboxId: item.outboxId })).toBeNull();
    expect((await messages(t, capture.threads[0].id)).find((m) => m.id === sent.id)?.delivery?.status).toBe("failed");
    await expect(t.mutation(internal.instagram.send.message, { accountId, conversationId: capture.threads[0].id, text: "hi" })).rejects.toThrow();
  });
});
