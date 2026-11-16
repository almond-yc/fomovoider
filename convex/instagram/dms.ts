import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requireUserId } from "../lib/auth";
import { vMedia, vPerson, type MessageInput } from "../lib/validators";
import { ownedAccount } from "./agent";
import { killSwitch } from "./common";
import { DM_CLAIM_TIMEOUT_MS, DM_QUEUE_TTL_MS, DM_SYNC_MIN_GAP_MS, TRIPWIRE_PAUSE_MS } from "./limits";
import { vTripwire } from "./schema";

// Public functions for the DM plug-in of the app's hidden instagram.com web
// view (src/instagram/dms/). The phone parses what the page loads and the
// lightspeed socket pushes and submits it here; it also claims the sends and
// seen receipts that send.message and send.markRead queue, does them through
// the page and completes them. Primary inbox only: messages of threads the
// inbox never showed are dropped.

type Person = Infer<typeof vPerson>;
type Outbox = Doc<"instagram_outbox">;

const iso = (ms: number) => new Date(ms).toISOString();
export const localMessageId = (outboxId: Id<"instagram_outbox">) => `instagram:local:${outboxId}`;
export const UNCONFIRMED = "Instagram didn't confirm this message. Open the chat in Instagram before sending it again.";

async function webviewDevice(ctx: QueryCtx, userId: Id<"users">) {
  const device = await ctx.db
    .query("instagram_devices")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();
  return device?.accountId && device.transport === "webview" ? device : null;
}

// Why the web view may not touch Instagram for this user now, or null.
async function blocked(ctx: QueryCtx, device: Doc<"instagram_devices"> | null) {
  if (!device) return "Instagram isn't connected.";
  if (await killSwitch(ctx)) return "Instagram is paused right now.";
  if (device.pausedUntil !== undefined && device.pausedUntil > Date.now()) return "Instagram is paused after a security check.";
  return null;
}

async function dmState(ctx: QueryCtx, userId: Id<"users">) {
  return await ctx.db
    .query("instagram_dmState")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

async function conversationRow(ctx: QueryCtx, userId: Id<"users">, conversationId: string) {
  return await ctx.db
    .query("conversations")
    .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", conversationId))
    .unique();
}

export async function threadRow(ctx: QueryCtx, userId: Id<"users">, conversationId: string) {
  return await ctx.db
    .query("instagram_threads")
    .withIndex("by_userId_and_conversationId", (q) => q.eq("userId", userId).eq("conversationId", conversationId))
    .unique();
}

async function messageRow(ctx: QueryCtx, userId: Id<"users">, id: string) {
  return await ctx.db
    .query("messages")
    .withIndex("by_userId_and_id", (q) => q.eq("userId", userId).eq("id", id))
    .unique();
}

// Asks before the web view loads the inbox: refused while Instagram is paused
// or not connected, and spaced per trigger (limits.ts).
export const startSync = mutation({
  args: { trigger: v.union(v.literal("open"), v.literal("realtime"), v.literal("background")) },
  returns: v.union(
    v.object({ kind: v.literal("run") }),
    v.object({ kind: v.literal("wait"), retryAt: v.number() }),
    v.object({ kind: v.literal("blocked"), reason: v.string() }),
  ),
  handler: async (ctx, { trigger }) => {
    const userId = await requireUserId(ctx);
    const device = await webviewDevice(ctx, userId);
    const reason = await blocked(ctx, device);
    if (reason) return { kind: "blocked" as const, reason };
    await ownedAccount(ctx, device!);
    const now = Date.now();
    const state = await dmState(ctx, userId);
    const retryAt = (state?.lastSyncAt ?? 0) + DM_SYNC_MIN_GAP_MS[trigger];
    if (retryAt > now) return { kind: "wait" as const, retryAt };
    if (state) await ctx.db.patch(state._id, { lastSyncAt: now });
    else await ctx.db.insert("instagram_dmState", { userId, viewerIds: [], lastSyncAt: now });
    return { kind: "run" as const };
  },
});

const vMember = v.object({ fbid: v.string(), person: vPerson });

// What the phone captured: inbox threads, messages (live ones arrived over
// the socket), senders seen on messages, and read receipts.
export const submit = mutation({
  args: {
    viewerIds: v.array(v.string()),
    threads: v.array(
      v.object({
        id: v.string(),
        threadKey: v.string(),
        title: v.optional(v.string()),
        isGroup: v.boolean(),
        members: v.array(vMember),
        updatedAt: v.string(),
        unreadCount: v.number(),
      }),
    ),
    messages: v.array(
      v.object({
        id: v.string(),
        conversationId: v.string(),
        senderFbid: v.string(),
        sentAt: v.string(),
        text: v.string(),
        media: v.array(vMedia),
        live: v.optional(v.boolean()),
      }),
    ),
    senders: v.array(vMember),
    receipts: v.array(v.object({ conversationId: v.string(), participantFbid: v.string(), watermark: v.number() })),
  },
  returns: v.object({ conversations: v.number(), messages: v.number() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const device = await webviewDevice(ctx, userId);
    if (await blocked(ctx, device)) throw new Error("Instagram is paused or not connected");
    const accountId = await ownedAccount(ctx, device!);
    const account = (await ctx.db.get(accountId))!;
    if (account.status === "pending" || account.status === "resetting" || !account.me) {
      return { conversations: 0, messages: 0 };
    }
    const me = account.me;
    const now = Date.now();
    for (const id of [...args.threads.map((t) => t.id), ...args.messages.map((m) => m.conversationId)]) {
      if (!id.startsWith("instagram:")) throw new Error(`Id ${id} is not an Instagram id`);
    }

    let state = await dmState(ctx, userId);
    const viewerIds = [...new Set([...args.viewerIds, ...(state?.viewerIds ?? [])])].slice(0, 6);
    if (state) await ctx.db.patch(state._id, { viewerIds });
    else await ctx.db.insert("instagram_dmState", { userId, viewerIds });
    const viewer = new Set(viewerIds);

    // Threads: who is in them and the id their URL uses.
    const threads = new Map<string, Doc<"instagram_threads">>();
    for (const t of args.threads) {
      const row = await threadRow(ctx, userId, t.id);
      const doc = { userId, conversationId: t.id, threadKey: t.threadKey, members: t.members, updatedAt: now };
      if (row) await ctx.db.replace(row._id, doc);
      else await ctx.db.insert("instagram_threads", doc);
      threads.set(t.id, { ...(row ?? ({} as Doc<"instagram_threads">)), ...doc });
    }
    for (const m of args.messages) {
      if (!threads.has(m.conversationId)) {
        const row = await threadRow(ctx, userId, m.conversationId);
        if (row) threads.set(m.conversationId, row);
      }
    }
    const people = new Map<string, Person>();
    for (const row of threads.values()) for (const member of row.members) if (member.fbid) people.set(member.fbid, member.person);
    for (const sender of args.senders) people.set(sender.fbid, sender.person);
    const senderOf = (fbid: string): Person =>
      viewer.has(fbid)
        ? me
        : people.get(fbid) ?? { id: "instagram:" + fbid, platform: "instagram", handle: fbid, displayName: "Instagram user" };

    // Messages of known (Primary inbox) threads only. One of the viewer's
    // own replaces the pending row its send showed.
    const messages: (MessageInput & { live?: boolean })[] = [];
    const isNew = new Map<string, boolean>();
    const richer = new Map<string, (typeof args.messages)[number]>();
    for (const m of args.messages) {
      const seen = richer.get(m.id);
      if (!seen || m.media.length > seen.media.length || (m.media.length === seen.media.length && m.text.length > seen.text.length)) {
        richer.set(m.id, { ...m, live: m.live || seen?.live });
      }
    }
    for (const { senderFbid, live, ...m } of richer.values()) {
      if (!threads.has(m.conversationId)) continue;
      const isMine = viewer.has(senderFbid);
      if (isMine) await replaceLocalCopy(ctx, userId, m.conversationId, m.text, Date.parse(m.sentAt));
      isNew.set(m.id, !(await messageRow(ctx, userId, m.id)));
      messages.push({ ...m, sender: senderOf(senderFbid), isMine, ...(live ? { live } : {}) });
    }
    if (messages.length) {
      await ctx.runMutation(internal.ingest.upsertMessages, {
        accountId,
        messages: messages.map(({ live: _live, ...m }) => m),
      });
    }

    // Inbox threads replace their conversation; the inbox is the source of
    // truth for unread counts. A newer local send keeps its preview.
    const newest = new Map<string, MessageInput>();
    for (const m of messages) {
      const best = newest.get(m.conversationId);
      if (!best || Date.parse(m.sentAt) > Date.parse(best.sentAt)) newest.set(m.conversationId, m);
    }
    const conversations = [];
    for (const t of args.threads) {
      const existing = await conversationRow(ctx, userId, t.id);
      const keepPreview = existing?.lastMessage && existing.updatedAt > Date.parse(t.updatedAt);
      const last = newest.get(t.id);
      conversations.push({
        id: t.id,
        platform: "instagram",
        participants: t.members.map((m) => m.person),
        ...(t.title ? { title: t.title } : {}),
        unreadCount: t.unreadCount,
        ...(keepPreview
          ? { lastMessage: { ...existing.lastMessage!, sentAt: iso(existing.lastMessage!.sentAt) }, updatedAt: iso(existing.updatedAt) }
          : { ...(last ? { lastMessage: last } : {}), updatedAt: t.updatedAt }),
      });
    }
    if (conversations.length) await ctx.runMutation(internal.ingest.upsertConversations, { accountId, conversations });

    // Messages outside an inbox page move their conversation's preview; a
    // new one from someone else that arrived live is unread.
    const inInbox = new Set(args.threads.map((t) => t.id));
    for (const m of messages) {
      if (inInbox.has(m.conversationId)) continue;
      const conversation = await conversationRow(ctx, userId, m.conversationId);
      if (!conversation) continue;
      const sentAt = Date.parse(m.sentAt);
      const patch: Partial<Doc<"conversations">> = {};
      if (sentAt >= conversation.updatedAt) Object.assign(patch, { lastMessage: { ...m, live: undefined, sentAt }, updatedAt: sentAt });
      if (m.live && !m.isMine && isNew.get(m.id)) patch.unreadCount = (conversation.unreadCount ?? 0) + 1;
      if (Object.keys(patch).length) {
        if (patch.lastMessage) delete (patch.lastMessage as { live?: boolean }).live;
        await ctx.db.patch(conversation._id, patch);
      }
    }

    // The viewer read a chat elsewhere (the Instagram app, another browser).
    for (const r of args.receipts) {
      if (!viewer.has(r.participantFbid) || inInbox.has(r.conversationId)) continue;
      const conversation = await conversationRow(ctx, userId, r.conversationId);
      if (conversation?.unreadCount && r.watermark >= (conversation.lastMessage?.sentAt ?? 0)) {
        await ctx.db.patch(conversation._id, { unreadCount: 0 });
      }
    }
    return { conversations: conversations.length, messages: messages.length };
  },
});

// A send Instagram confirmed without a message id, for this text and within
// 5 minutes of sentAt: the captured copy of the message replaces it. Pending
// rows are never touched; complete reconciles them by id.
async function replaceLocalCopy(ctx: MutationCtx, userId: Id<"users">, conversationId: string, text: string, sentAt: number) {
  const window = 5 * 60_000;
  const rows = await ctx.db
    .query("messages")
    .withIndex("by_userId_and_conversationId_and_sentAt", (q) =>
      q.eq("userId", userId).eq("conversationId", conversationId).gte("sentAt", sentAt - window).lte("sentAt", sentAt + window),
    )
    .collect();
  const local = rows.find((r) => r.id.startsWith("instagram:local:") && r.delivery?.status === "sent" && r.text.trim() === text.trim());
  if (local) await ctx.db.delete(local._id);
}

// Pending sends and seen receipts for the phone, oldest first. Empty while
// Instagram is paused or not connected.
export const outbox = query({
  args: {},
  returns: v.array(v.object({ outboxId: v.id("instagram_outbox"), kind: v.union(v.literal("send"), v.literal("markRead")) })),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    if (await blocked(ctx, await webviewDevice(ctx, userId))) return [];
    const rows = await ctx.db
      .query("instagram_outbox")
      .withIndex("by_userId_and_state", (q) => q.eq("userId", userId).eq("state", "pending"))
      .take(10);
    return rows.map((r) => ({ outboxId: r._id, kind: r.kind }));
  },
});

const vTask = v.union(
  v.object({ outboxId: v.id("instagram_outbox"), kind: v.literal("send"), threadKey: v.string(), text: v.string() }),
  v.object({ outboxId: v.id("instagram_outbox"), kind: v.literal("markRead"), threadKey: v.string() }),
);

// Takes one pending item for the phone to do now. Null when it was taken,
// or when Instagram is paused (a send then fails; a seen receipt is dropped).
export const claim = mutation({
  args: { outboxId: v.id("instagram_outbox") },
  returns: v.union(vTask, v.null()),
  handler: async (ctx, { outboxId }) => {
    const userId = await requireUserId(ctx);
    const row = await ctx.db.get(outboxId);
    if (!row || row.userId !== userId || row.state !== "pending") return null;
    const device = await webviewDevice(ctx, userId);
    const account = device?.accountId ? await ctx.db.get(device.accountId) : null;
    const thread = await threadRow(ctx, userId, row.conversationId);
    const reason =
      (await blocked(ctx, device)) ??
      (account?._id !== row.accountId || account?.status !== "active" || account.me?.id !== row.meId
        ? "Instagram was reconnected since this was queued."
        : Date.now() - row.createdAt > DM_QUEUE_TTL_MS
          ? "Instagram wasn't reachable in time; this wasn't sent."
          : !thread
            ? "This chat isn't in the Instagram inbox."
            : null);
    if (reason || !thread) {
      await finishOutbox(ctx, row, { ok: false, error: reason ?? "This chat isn't in the Instagram inbox." });
      return null;
    }
    await ctx.db.patch(row._id, { state: "claimed", claimedAt: Date.now() });
    await ctx.scheduler.runAfter(DM_CLAIM_TIMEOUT_MS, internal.instagram.dms.expireClaim, { outboxId });
    return row.kind === "send"
      ? { outboxId, kind: "send" as const, threadKey: thread.threadKey, text: row.text ?? "" }
      : { outboxId, kind: "markRead" as const, threadKey: thread.threadKey };
  },
});

const vResult = v.union(
  v.object({ ok: v.literal(true), messageId: v.optional(v.string()), sentAt: v.optional(v.string()) }),
  v.object({ ok: v.literal(false), error: v.string() }),
);

export const complete = mutation({
  args: { outboxId: v.id("instagram_outbox"), result: vResult },
  returns: v.null(),
  handler: async (ctx, { outboxId, result }) => {
    const userId = await requireUserId(ctx);
    const row = await ctx.db.get(outboxId);
    if (!row || row.userId !== userId) throw new Error("Outbox item not found");
    // A send the claim timeout already failed may still have gone out.
    const late = row.state === "failed" && row.error === UNCONFIRMED && result.ok;
    if (row.state !== "claimed" && !late) return null;
    await finishOutbox(ctx, row, result);
    return null;
  },
});

export const expireClaim = internalMutation({
  args: { outboxId: v.id("instagram_outbox") },
  returns: v.null(),
  handler: async (ctx, { outboxId }) => {
    const row = await ctx.db.get(outboxId);
    if (row?.state === "claimed") await finishOutbox(ctx, row, { ok: false, error: UNCONFIRMED });
    return null;
  },
});

// Records an outbox item's result. A send's row flips to sent, with
// Instagram's message id and time when the page's response had them, or to
// failed with the error; a seen receipt clears the unread count.
async function finishOutbox(ctx: MutationCtx, row: Outbox, result: Infer<typeof vResult>) {
  await ctx.db.patch(row._id, result.ok ? { state: "done", error: undefined } : { state: "failed", error: result.error });
  const conversation = await conversationRow(ctx, row.userId, row.conversationId);
  if (row.kind === "markRead") {
    if (result.ok && conversation?.unreadCount) await ctx.db.patch(conversation._id, { unreadCount: 0 });
    return;
  }
  const message = row.messageId ? await messageRow(ctx, row.userId, row.messageId) : null;
  if (!message) return;
  let next: Doc<"messages"> | null = null;
  if (!result.ok) {
    await ctx.db.patch(message._id, { delivery: { status: "failed", error: result.error } });
    next = { ...message, delivery: { status: "failed", error: result.error } };
  } else {
    const id = result.messageId ?? message.id;
    const sentAt = result.sentAt ? Date.parse(result.sentAt) : message.sentAt;
    const captured = id !== message.id ? await messageRow(ctx, row.userId, id) : null;
    if (captured) {
      await ctx.db.delete(message._id);
      next = captured;
    } else {
      await ctx.db.patch(message._id, { id, sentAt, delivery: { status: "sent" } });
      next = { ...message, id, sentAt, delivery: { status: "sent" } };
    }
    if (id !== message.id) await ctx.db.patch(row._id, { messageId: id });
  }
  if (conversation && conversation.lastMessage?.id === message.id) {
    const { _id, _creationTime, userId: _u, ...lastMessage } = next;
    await ctx.db.patch(conversation._id, { lastMessage, updatedAt: Math.max(conversation.updatedAt, lastMessage.sentAt) });
  }
}

// The page showed a challenge or login screen during DM work: pause the
// device like a feed refresh does (72 hours) and mark the account.
export const tripwire = mutation({
  args: { tripwire: vTripwire },
  returns: v.null(),
  handler: async (ctx, { tripwire }) => {
    const userId = await requireUserId(ctx);
    const device = await webviewDevice(ctx, userId);
    if (!device) return null;
    const accountId = await ownedAccount(ctx, device);
    const pausedUntil = Date.now() + TRIPWIRE_PAUSE_MS;
    await ctx.db.patch(device._id, { pausedUntil, pauseReason: `${tripwire.kind}: ${tripwire.screenText.slice(0, 200)}` });
    await ctx.runMutation(internal.accounts.recordSync, {
      accountId,
      error:
        tripwire.kind === "suspicious"
          ? { kind: "rate_limited", retryAt: new Date(pausedUntil).toISOString() }
          : { kind: "session_expired" },
    });
    return null;
  },
});
