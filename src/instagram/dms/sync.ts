import type { HookMessage } from "../hook";
import { parseResponseText } from "../parse";
import type { PageControl } from "../refresh";
import { tripwireFor, type Tripwire } from "../tripwire";
import {
  BACK_JS,
  CLICK_SEND_JS,
  CLEAR_COMPOSER_JS,
  INBOX_URL,
  openThreadRowJs,
  PAGE_STATE_JS,
  threadUrl,
  typeJs,
  type DmHookMessage,
} from "./page";
import {
  emptyCapture,
  INBOX_OPERATION,
  MARK_READ_OPERATION,
  parseDeltas,
  parseInbox,
  parseSendResponse,
  parseThreadDetail,
  SEND_OPERATION,
  THREAD_OPERATION,
  type DmCapture,
  type DmMessage,
  type DmViewer,
  type SendOutcome,
} from "./parse";

// The phone side of Instagram DMs. Capture runs all the time the hidden web
// view is up: it parses what the page loads and what the lightspeed socket
// pushes, and streams it to Convex. Work that drives the page (loading the
// inbox, opening a chat so Instagram marks it seen, typing and sending a
// message) runs as host tasks, one at a time, after Convex allows it.

export type SyncTrigger = "open" | "realtime" | "background";
export type SyncStart = { kind: "run" } | { kind: "wait"; retryAt: number } | { kind: "blocked"; reason: string };
export type OutboxTask =
  | { outboxId: string; kind: "send"; threadKey: string; text: string }
  | { outboxId: string; kind: "markRead"; threadKey: string };
export type OutboxResult = SendOutcome;

export interface DmSubmit {
  // The page's logged-in Instagram user; Convex rejects the batch unless it
  // is the account's own.
  viewer: DmViewer;
  viewerIds: string[];
  threads: DmCapture["threads"];
  // live: arrived over the socket, so it is new since the inbox loaded.
  messages: (DmMessage & { live?: boolean })[];
  senders: DmCapture["senders"];
  receipts: DmCapture["receipts"];
}

export interface DmApi {
  startSync(args: { trigger: SyncTrigger }): Promise<SyncStart>;
  submit(args: DmSubmit): Promise<unknown>;
  complete(args: { outboxId: string; result: OutboxResult }): Promise<unknown>;
  tripwire(args: { tripwire: Tripwire }): Promise<unknown>;
}

type Json = any;
type Message = HookMessage | DmHookMessage;

const FLUSH_DELAY_MS = 1_500;
const INBOX_TIMEOUT_MS = 15_000;
const OPEN_TIMEOUT_MS = 12_000;
const SEND_TIMEOUT_MS = 20_000;
const MARK_READ_WAIT_MS = 6_000;
const TYPE_CHUNK = 30;
// The longest message Instagram's composer takes.
export const MAX_TEXT_LENGTH = 1_000;

export interface DmCaptureDeps {
  api: Pick<DmApi, "submit">;
  // The connected account's Instagram handle. Captures are held until a
  // thread shows the page is logged in as this user, and dropped when it
  // shows anyone else.
  expectedHandle(): string | undefined;
  // Something changed that only an inbox reload shows: a delta the parsers
  // don't read, or a gap in the sequence ids.
  onStale(): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

type Pending = Omit<DmSubmit, "viewer">;
const emptyPending = (): Pending => ({ viewerIds: [], threads: [], messages: [], senders: [], receipts: [] });

export function createDmCapture(deps: DmCaptureDeps) {
  const setTimer = deps.setTimer ?? setTimeout;
  let pending = emptyPending();
  let scheduled = false;
  let lastSeq = 0;
  // The verified page viewer and the handle it was verified for.
  let viewer: (DmViewer & { for: string }) | undefined;
  const waiters = new Set<{ operation: string; resolve: (docs: Json[]) => void }>();

  // Forgets everything captured: another Fomovoider user or Instagram
  // account is now in play.
  const reset = () => {
    pending = emptyPending();
    viewer = undefined;
    lastSeq = 0;
  };

  // The page's viewer if it is the expected account. A capture showing
  // someone else resets the capture and is dropped.
  const verify = (capture: DmCapture) => {
    const expected = deps.expectedHandle();
    if (!expected) {
      reset();
      return false;
    }
    if (viewer && viewer.for !== expected) reset();
    if (capture.viewer) {
      if (capture.viewer.handle !== expected) {
        reset();
        return false;
      }
      viewer = { ...capture.viewer, for: expected };
    }
    return true;
  };

  const add = (capture: DmCapture, live: boolean) => {
    if (!verify(capture)) return;
    for (const id of capture.viewerIds) if (!pending.viewerIds.includes(id)) pending.viewerIds.push(id);
    pending.threads.push(...capture.threads);
    pending.messages.push(...capture.messages.map((m) => (live ? { ...m, live } : m)));
    pending.senders.push(...capture.senders);
    pending.receipts.push(...capture.receipts);
    if (!scheduled && (capture.threads.length || capture.messages.length || capture.receipts.length)) {
      scheduled = true;
      setTimer(() => void flush(), FLUSH_DELAY_MS);
    }
  };

  // Sends what was captured, once the page's viewer is verified for the
  // expected account; until then it waits for a thread detail to show it.
  const flush = async () => {
    scheduled = false;
    const expected = deps.expectedHandle();
    if (!viewer || viewer.for !== expected) return;
    const batch = pending;
    pending = { ...emptyPending(), viewerIds: [...batch.viewerIds] };
    if (batch.threads.length || batch.messages.length || batch.receipts.length) {
      await deps.api.submit({ ...batch, viewer: { handle: viewer.handle, fbid: viewer.fbid } });
    }
  };

  const handle = (message: Message) => {
    if (message.type === "ig:ws") {
      const capture = emptyCapture();
      for (const payload of message.payloads) parseDeltas(payload, capture);
      let stale = capture.changed.length > 0;
      for (const seq of [...capture.seqIds].sort((a, b) => a - b)) {
        if (lastSeq && seq > lastSeq + 1) stale = true;
        lastSeq = Math.max(lastSeq, seq);
      }
      add(capture, true);
      if (stale) deps.onStale();
      return;
    }
    if (message.type !== "ig:response") return;
    const docs = message.status === 200 ? parseResponseText(message.body) : [];
    for (const waiter of [...waiters]) {
      if (waiter.operation !== message.operation) continue;
      waiters.delete(waiter);
      waiter.resolve(docs);
    }
    if (message.operation === INBOX_OPERATION) {
      const capture = emptyCapture();
      for (const doc of docs) parseInbox(doc, capture);
      // The page resumes its socket from the inbox's sequence id.
      if (capture.seqIds.length) lastSeq = Math.max(...capture.seqIds);
      add(capture, false);
    } else if (message.operation === THREAD_OPERATION) {
      const capture = emptyCapture();
      for (const doc of docs) parseThreadDetail(doc, capture);
      add(capture, false);
    }
  };

  // The next response to operation, or undefined after timeoutMs.
  const next = (operation: string, timeoutMs: number) =>
    new Promise<Json[] | undefined>((resolve) => {
      const waiter = { operation, resolve };
      waiters.add(waiter);
      setTimer(() => {
        if (waiters.delete(waiter)) resolve(undefined);
      }, timeoutMs);
    });

  // True once the page showed it is logged in as the expected account.
  const verified = () => Boolean(viewer && viewer.for === deps.expectedHandle());

  return { handle, next, flush, reset, verified };
}

export type DmCaptureHandle = ReturnType<typeof createDmCapture>;

export interface DmTaskDeps {
  page: PageControl;
  capture: DmCaptureHandle;
  api: DmApi;
  killed(): boolean;
  sleep(ms: number): Promise<void>;
  random?: () => number;
}

class Tripped extends Error {
  constructor(readonly tripwire: Tripwire) {
    super("tripwire");
  }
}

// Runs fn while watching the page's location for a challenge or login page;
// on one it reports the tripwire (Convex pauses the device) and throws.
async function guarded<T>(deps: DmTaskDeps, fn: (check: () => void) => Promise<T>): Promise<T> {
  let tripwire: Tripwire | undefined;
  const unsubscribe = deps.page.onMessage((m) => {
    if (m.type === "ig:location") tripwire ??= tripwireFor(m.href, m.title) ?? undefined;
  });
  const check = () => {
    if (tripwire) throw new Tripped(tripwire);
  };
  try {
    return await fn(check);
  } finally {
    unsubscribe();
    if (tripwire) await deps.api.tripwire({ tripwire });
  }
}

// Loads the Primary inbox when Convex says it's due. The page's own inbox
// query and the thread histories it prefetches reach Convex through capture.
export async function syncInbox(trigger: SyncTrigger, deps: DmTaskDeps) {
  const start = await deps.api.startSync({ trigger });
  if (start.kind !== "run") return start;
  return await guarded(deps, async (check) => {
    const inbox = deps.capture.next(INBOX_OPERATION, INBOX_TIMEOUT_MS);
    await deps.page.goto(INBOX_URL);
    const docs = await inbox;
    check();
    await deps.capture.flush();
    return docs ? start : ({ kind: "blocked", reason: "The inbox did not load" } as const);
  });
}

type PageState = { path: string; composer: boolean; text: string | null };

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

// Opens the chat as a person would (its inbox row, else its URL) and waits
// for its composer. Instagram marks the chat seen when it opens.
async function openThread(threadKey: string, deps: DmTaskDeps, check: () => void) {
  const path = `/direct/t/${threadKey}/`;
  const state = await deps.page.evaluate<PageState>(PAGE_STATE_JS);
  const tapped = state.path.startsWith("/direct/") && (await deps.page.evaluate<boolean>(openThreadRowJs(threadKey)));
  if (!tapped) await deps.page.goto(threadUrl(threadKey));
  for (let waited = 0; waited < OPEN_TIMEOUT_MS; waited += 500) {
    check();
    const now = await deps.page.evaluate<PageState>(PAGE_STATE_JS);
    if (now.path === path && now.composer) return { state: now, tapped };
    await deps.sleep(500);
  }
  return undefined;
}

// Back to the inbox, so later messages in this chat aren't marked seen.
async function backToInbox(tapped: boolean, deps: DmTaskDeps) {
  if (tapped) {
    await deps.page.evaluate(BACK_JS);
    for (let waited = 0; waited < 5_000; waited += 500) {
      await deps.sleep(500);
      if ((await deps.page.evaluate<PageState>(PAGE_STATE_JS)).path === "/direct/inbox/") return;
    }
  }
  await deps.page.goto(INBOX_URL);
}

// Delivers one claimed outbox task through the page and returns its result
// for Convex. A send is typed into the chat's composer and sent with its
// Send button exactly once; nothing here retries a send.
export async function deliver(task: OutboxTask, deps: DmTaskDeps): Promise<OutboxResult> {
  if (!deps.capture.verified()) return { ok: false, error: "Instagram in this app is logged in as a different account." };
  const random = deps.random ?? Math.random;
  const pause = (min: number, max: number) => deps.sleep(min + random() * (max - min));
  try {
    return await guarded(deps, async (check) => {
      const markRead = task.kind === "markRead" ? deps.capture.next(MARK_READ_OPERATION, MARK_READ_WAIT_MS) : undefined;
      const opened = await openThread(task.threadKey, deps, check);
      if (!opened) return { ok: false as const, error: "Couldn't open this chat on Instagram." };
      try {
        if (task.kind === "markRead") {
          await markRead;
          await pause(1_500, 3_000);
          return { ok: true as const };
        }
        if (opened.state.text) return { ok: false as const, error: "This chat has an unsent draft on Instagram." };
        await pause(600, 1_400);
        let typed = "";
        for (let i = 0; i < task.text.length; i += TYPE_CHUNK) {
          check();
          typed = (await deps.page.evaluate<string | null>(typeJs(task.text.slice(i, i + TYPE_CHUNK)))) ?? "";
        }
        if (normalize(typed) !== normalize(task.text) || deps.killed()) {
          await deps.page.evaluate(CLEAR_COMPOSER_JS);
          return { ok: false as const, error: deps.killed() ? "Instagram is paused." : "Couldn't type this message on Instagram." };
        }
        await pause(400, 1_000);
        check();
        const response = deps.capture.next(SEND_OPERATION, SEND_TIMEOUT_MS);
        if (!(await deps.page.evaluate<boolean>(CLICK_SEND_JS))) {
          await deps.page.evaluate(CLEAR_COMPOSER_JS);
          return { ok: false as const, error: "Couldn't find Instagram's Send button." };
        }
        const docs = await response;
        const outcome = docs?.length
          ? parseSendResponse(docs[0])
          : { ok: false as const, error: "Instagram didn't confirm this message. Open the chat in Instagram before sending it again." };
        await pause(800, 1_600);
        return outcome;
      } finally {
        await backToInbox(opened.tapped, deps);
      }
    });
  } catch (err) {
    if (err instanceof Tripped) return { ok: false, error: "Instagram asked to verify the account. Open Instagram to continue." };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
