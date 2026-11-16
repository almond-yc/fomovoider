import { describe, expect, test } from "vitest";
import type { HookMessage } from "../hook";
import inbox from "./__fixtures__/dm-inbox.json";
import detail from "./__fixtures__/dm-thread-detail.json";
import { parseThreadDetail } from "./parse";
import sendError from "./__fixtures__/dm-send-error.json";
import { CLICK_SEND_JS, CLEAR_COMPOSER_JS, PAGE_STATE_JS } from "./page";
import { createDmCapture, deliver, type DmApi, type DmSubmit } from "./sync";

type Listener = (m: HookMessage) => void;

// The fixtures' logged-in user, as a thread detail shows it.
const VIEWER = parseThreadDetail(detail).viewer!.handle;
const detailResponse: HookMessage = { type: "ig:response", operation: "IGDThreadDetailQuery", status: 200, body: JSON.stringify(detail) };

// A fake instagram.com page: an inbox with one chat row, a composer that
// collects typed text, and a Send button that answers with sendResponse.
function fakePage(sendResponse: unknown) {
  const listeners = new Set<Listener>();
  const emit = (m: HookMessage) => listeners.forEach((l) => l(m));
  let path = "/direct/inbox/";
  let text = "";
  const calls: string[] = [];
  const page = {
    hookKey: "_test",
    goto: async (url: string) => {
      calls.push("goto " + url);
      path = new URL(url).pathname;
    },
    evaluate: async <T,>(js: string): Promise<T> => {
      if (js === PAGE_STATE_JS) return { path, composer: path.startsWith("/direct/t/"), text } as T;
      if (js.includes("a[href=")) {
        path = js.match(/\/direct\/t\/\d+\//)![0];
        calls.push("tap row");
        return true as T;
      }
      if (js.includes("insertText")) {
        text += JSON.parse(js.match(/for \(const ch of ("(?:[^"\\]|\\.)*")\)/)![1]);
        return text as T;
      }
      if (js === CLICK_SEND_JS) {
        calls.push("send " + text);
        setTimeout(() => emit({ type: "ig:response", operation: "IGDirectTextSendMutation", status: 200, body: JSON.stringify(sendResponse) }));
        text = "";
        return true as T;
      }
      if (js === CLEAR_COMPOSER_JS) {
        text = "";
        return true as T;
      }
      if (js.includes("history.back")) {
        calls.push("back");
        path = "/direct/inbox/";
      }
      return undefined as T;
    },
    onMessage: (l: Listener) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
  return { page, emit, calls };
}

const api = (submitted: DmSubmit[] = []): DmApi => ({
  startSync: async () => ({ kind: "run" }),
  submit: async (args) => void submitted.push(args),
  complete: async () => undefined,
  tripwire: async () => undefined,
});

async function harness(sendResponse: unknown) {
  const fake = fakePage(sendResponse);
  const capture = createDmCapture({ api: api(), expectedHandle: () => VIEWER, onStale: () => undefined, setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 5)) });
  fake.page.onMessage(capture.handle);
  capture.handle(detailResponse);
  await capture.flush();
  const deps = { page: fake.page, capture, api: api(), killed: () => false, sleep: async () => undefined, random: () => 0 };
  return { ...fake, deps };
}

describe("instagram dm delivery", () => {
  test("a send opens the chat from the inbox, types, taps Send once and goes back", async () => {
    const h = await harness({ data: { xig_direct_text_send_with_slide_messaging_response: { message_id: "mid.$1", timestamp_ms: "1794786600000" } } });
    const result = await deliver({ outboxId: "o1", kind: "send", threadKey: "123", text: "got it, testing a reply, ignore this" }, h.deps);
    expect(result).toEqual({ ok: true, messageId: "instagram:mid.$1", sentAt: new Date(1794786600000).toISOString() });
    expect(h.calls).toEqual(["tap row", "send got it, testing a reply, ignore this", "back"]);
  });

  test("Instagram's error comes back as the send's error, without a second try", async () => {
    const h = await harness(sendError);
    const result = await deliver({ outboxId: "o1", kind: "send", threadKey: "123", text: "hi" }, h.deps);
    expect(result).toEqual({ ok: false, error: "Instagram didn't send this message (error 1675030). Open the chat in Instagram to check." });
    expect(h.calls.filter((c) => c.startsWith("send"))).toHaveLength(1);
  });

  test("a login page during a send aborts it and reports the tripwire", async () => {
    const h = await harness({});
    const tripped: unknown[] = [];
    h.deps.api = { ...h.deps.api, tripwire: async (a) => void tripped.push(a) };
    const original = h.page.evaluate;
    h.page.evaluate = async <T,>(js: string) => {
      if (js.includes("a[href=")) h.emit({ type: "ig:location", href: "https://www.instagram.com/accounts/login/", title: "Login" });
      return original<T>(js);
    };
    const result = await deliver({ outboxId: "o1", kind: "send", threadKey: "123", text: "hi" }, h.deps);
    expect(result.ok).toBe(false);
    expect(tripped).toHaveLength(1);
    expect(h.calls.some((c) => c.startsWith("send"))).toBe(false);
  });

  test("capture streams the inbox to Convex and flags a sequence gap as stale", async () => {
    const submitted: DmSubmit[] = [];
    let stale = 0;
    let ready = 0;
    const capture = createDmCapture({ api: api(submitted), expectedHandle: () => VIEWER, onReady: () => ready++, onStale: () => stale++, setTimer: (fn) => setTimeout(fn, 0) });
    capture.handle({ type: "ig:response", operation: "PolarisDirectInboxMobileQuery", status: 200, body: JSON.stringify(inbox) });
    await capture.flush();
    expect(submitted).toEqual([]);
    capture.handle(detailResponse);
    await capture.flush();
    expect(submitted[0].threads).toHaveLength(4);
    expect(submitted[0].viewer.handle).toBe(VIEWER);
    // The outbox starts once Convex accepted a verified batch.
    expect(ready).toBe(1);
    const delta = (seq: number) => ({
      type: "ig:ws" as const,
      payloads: [JSON.stringify([{ data: { slide_delta_processor: [{ __typename: "SlideUQPPCreateReaction", uq_seq_id: String(seq) }] } }])],
    });
    capture.handle(delta(19889) as unknown as HookMessage);
    expect(stale).toBe(0);
    capture.handle(delta(19895) as unknown as HookMessage);
    expect(stale).toBe(1);
  });

  test("a challenge page after Send still pauses the device", async () => {
    const h = await harness({ data: { xig_direct_text_send_with_slide_messaging_response: { message_id: "mid.$1" } } });
    const tripped: unknown[] = [];
    h.deps.api = { ...h.deps.api, tripwire: async (a) => void tripped.push(a) };
    const original = h.page.evaluate;
    h.page.evaluate = async <T,>(js: string) => {
      const out = await original<T>(js);
      if (js === CLICK_SEND_JS) h.emit({ type: "ig:location", href: "https://www.instagram.com/challenge/", title: "" });
      return out;
    };
    await deliver({ outboxId: "o1", kind: "send", threadKey: "123", text: "hi" }, h.deps);
    expect(tripped).toHaveLength(1);
  });

  test("inbox snippet and detail copies of one message keep the detail's media", async () => {
    const submitted: DmSubmit[] = [];
    const capture = createDmCapture({ api: api(submitted), expectedHandle: () => VIEWER, onStale: () => undefined, setTimer: () => undefined });
    capture.handle({ type: "ig:response", operation: "PolarisDirectInboxMobileQuery", status: 200, body: JSON.stringify(inbox) });
    capture.handle({ type: "ig:response", operation: "IGDThreadDetailQuery", status: 200, body: JSON.stringify(detail) });
    await capture.flush();
    const copies = submitted[0].messages.filter((m) => m.id === "instagram:mid.$10000004102042");
    expect(copies.length).toBe(2);
    expect(Math.max(...copies.map((m) => m.media.length))).toBeGreaterThan(0);
  });

  test("user A's page under user B: nothing is submitted and no send runs", async () => {
    const submitted: DmSubmit[] = [];
    let expected: string | undefined = "user_b";
    const capture = createDmCapture({ api: api(submitted), expectedHandle: () => expected, onStale: () => undefined, setTimer: () => undefined });
    capture.handle({ type: "ig:response", operation: "PolarisDirectInboxMobileQuery", status: 200, body: JSON.stringify(inbox) });
    capture.handle(detailResponse);
    await capture.flush();
    expect(submitted).toEqual([]);
    expect(capture.verified()).toBe(false);

    const h = await harness({ data: { xig_direct_text_send_with_slide_messaging_response: { message_id: "mid.$1" } } });
    const result = await deliver({ outboxId: "o1", kind: "send", threadKey: "123", text: "hi" }, { ...h.deps, capture });
    expect(result.ok).toBe(false);
    expect(h.calls).toEqual([]);

    // Signed in as A, verified; then B signs in: what A captured is dropped.
    expected = VIEWER;
    capture.handle({ type: "ig:response", operation: "PolarisDirectInboxMobileQuery", status: 200, body: JSON.stringify(inbox) });
    capture.handle(detailResponse);
    await capture.flush();
    expect(capture.verified()).toBe(true);
    const sentAsA = submitted.length;
    capture.handle({ type: "ig:response", operation: "PolarisDirectInboxMobileQuery", status: 200, body: JSON.stringify(inbox) });
    expected = "user_b";
    capture.reset();
    await capture.flush();
    expect(submitted).toHaveLength(sentAsA);
    expect(capture.verified()).toBe(false);
  });
});
