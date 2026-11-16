/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import inbox from "../../src/instagram/dms/__fixtures__/dm-inbox.json";
import detail from "../../src/instagram/dms/__fixtures__/dm-thread-detail.json";
import { emptyCapture, parseInbox, parseThreadDetail } from "../../src/instagram/dms/parse";

const modules = import.meta.glob("/convex/**/*.ts");
// The fixtures' viewer (a thread detail carries its username) is the
// connected account.
const viewer = parseThreadDetail(detail).viewer!;
const me = { id: "instagram:" + viewer.handle, platform: "instagram", handle: viewer.handle, displayName: "Nico" };

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
  const { seqIds: _s, changed: _c, viewer: _v, ...capture } = parseInbox(inbox, emptyCapture());
  await as.mutation(api.instagram.dms.submit, { ...capture, viewer, viewerIds: [...capture.viewerIds, viewer.fbid] });
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
    expect(mine.every((m) => m.sender.handle === me.handle)).toBe(true);
    expect(stored.filter((m) => !m.isMine).every((m) => m.sender.handle.startsWith("user_") || m.sender.displayName)).toBe(true);
  });

  test("messages of threads outside the Primary inbox are dropped; a live message bumps unread", async () => {
    const { t, as } = await connected();
    const capture = await submitInbox(as);
    const thread = capture.threads[0];
    const before = (await conversations(t)).find((c) => c.id === thread.id)!;
    const other = thread.members[0];
    const base = { senders: [], receipts: [], threads: [], viewer, viewerIds: [viewer.fbid] };
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
      viewer,
      viewerIds: [viewer.fbid],
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

  test("a queued send fails instead of going out under another identity, late, or after a same-text replay", async () => {
    vi.useFakeTimers();
    const { t, as, accountId } = await connected();
    const capture = await submitInbox(as);
    const conversationId = capture.threads[0].id;
    const viewerFbid = viewer.fbid;

    // A replay of an earlier "ok" doesn't touch the pending one.
    const pending = await t.mutation(internal.instagram.send.message, { accountId, conversationId, text: "ok" });
    await as.mutation(api.instagram.dms.submit, {
      viewer, viewerIds: [viewer.fbid], threads: [], senders: [], receipts: [],
      messages: [{ id: "instagram:mid.$old", conversationId, senderFbid: viewerFbid, sentAt: new Date(pending.sentAt - 60_000).toISOString(), text: "ok", media: [] }],
    });
    expect((await messages(t, conversationId)).some((m) => m.id === pending.id)).toBe(true);

    // Reconnected as someone else: the claim fails it.
    await t.run((ctx) => ctx.db.patch(accountId, { me: { ...me, id: "instagram:other", handle: "other" } }));
    let [item] = await as.query(api.instagram.dms.outbox, {});
    expect(await as.mutation(api.instagram.dms.claim, { outboxId: item.outboxId })).toBeNull();
    expect((await messages(t, conversationId)).find((m) => m.id === pending.id)?.delivery?.status).toBe("failed");

    // Queued while the app was closed for more than 10 minutes: fails.
    const late = await t.mutation(internal.instagram.send.message, { accountId, conversationId, text: "later" });
    [item] = await as.query(api.instagram.dms.outbox, {});
    await t.run((ctx) => ctx.db.patch(item.outboxId, { createdAt: Date.now() - 10 * 60_000 - 1 }));
    expect(await as.mutation(api.instagram.dms.claim, { outboxId: item.outboxId })).toBeNull();
    expect((await messages(t, conversationId)).find((m) => m.id === late.id)?.delivery?.status).toBe("failed");
    vi.useRealTimers();
  });

  test("another account's DMs are refused: a batch from a different Instagram user, and claims before this account's page is verified", async () => {
    const { t, as, accountId, userId } = await connected();
    const { seqIds: _s, changed: _c, viewer: _v, ...capture } = parseInbox(inbox, emptyCapture());
    // User B signed in while the phone's page is still logged in as A.
    await expect(
      as.mutation(api.instagram.dms.submit, { ...capture, viewer: { handle: "someone_else", fbid: viewer.fbid }, viewerIds: [viewer.fbid] }),
    ).rejects.toThrow(/different Instagram account/);
    await expect(
      as.mutation(api.instagram.dms.submit, { ...capture, viewer, viewerIds: ["1"] }),
    ).rejects.toThrow(/different Instagram account/);
    expect(await conversations(t)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toEqual([]);

    // Viewer ids verified for an earlier identity don't carry over.
    await t.run((ctx) => ctx.db.insert("instagram_dmState", { userId, viewerIds: ["stale"], meId: "instagram:previous" }));
    await submitInbox(as);
    const state = await t.run((ctx) => ctx.db.query("instagram_dmState").unique());
    expect(state?.meId).toBe(me.id);
    expect(state?.viewerIds).not.toContain("stale");

    // Claims wait until a verified batch for this identity has arrived.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("instagram_dmState").unique();
      await ctx.db.patch(row!._id, { meId: "instagram:previous" });
    });
    await t.mutation(internal.instagram.send.message, { accountId, conversationId: capture.threads[0].id, text: "hi" });
    const [item] = await as.query(api.instagram.dms.outbox, {});
    expect(await as.mutation(api.instagram.dms.claim, { outboxId: item.outboxId })).toBeNull();
    expect(await as.query(api.instagram.dms.outbox, {})).toHaveLength(1);
  });
});
