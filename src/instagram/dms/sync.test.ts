import { describe, expect, test } from "vitest";
import type { HookMessage } from "../hook";
import inbox from "./__fixtures__/dm-inbox.json";
import sendError from "./__fixtures__/dm-send-error.json";
import { CLICK_SEND_JS, CLEAR_COMPOSER_JS, PAGE_STATE_JS } from "./page";
import { createDmCapture, deliver, type DmApi, type DmSubmit } from "./sync";

type Listener = (m: HookMessage) => void;

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

function harness(sendResponse: unknown) {
  const fake = fakePage(sendResponse);
  const capture = createDmCapture({ api: api(), onStale: () => undefined, setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 5)) });
  fake.page.onMessage(capture.handle);
  const deps = { page: fake.page, capture, api: api(), killed: () => false, sleep: async () => undefined, random: () => 0 };
  return { ...fake, deps };
}

describe("instagram dm delivery", () => {
  test("a send opens the chat from the inbox, types, taps Send once and goes back", async () => {
    const h = harness({ data: { xig_direct_text_send_with_slide_messaging_response: { message_id: "mid.$1", timestamp_ms: "1794786600000" } } });
    const result = await deliver({ outboxId: "o1", kind: "send", threadKey: "123", text: "got it, testing a reply, ignore this" }, h.deps);
    expect(result).toEqual({ ok: true, messageId: "instagram:mid.$1", sentAt: new Date(1794786600000).toISOString() });
    expect(h.calls).toEqual(["tap row", "send got it, testing a reply, ignore this", "back"]);
  });

  test("Instagram's error comes back as the send's error, without a second try", async () => {
    const h = harness(sendError);
    const result = await deliver({ outboxId: "o1", kind: "send", threadKey: "123", text: "hi" }, h.deps);
    expect(result).toEqual({ ok: false, error: "Instagram didn't send this message (error 1675030). Open the chat in Instagram to check." });
    expect(h.calls.filter((c) => c.startsWith("send"))).toHaveLength(1);
  });

  test("a login page during a send aborts it and reports the tripwire", async () => {
    const h = harness({});
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
    const capture = createDmCapture({ api: api(submitted), onStale: () => stale++, setTimer: (fn) => setTimeout(fn, 0) });
    capture.handle({ type: "ig:response", operation: "PolarisDirectInboxMobileQuery", status: 200, body: JSON.stringify(inbox) });
    await capture.flush();
    expect(submitted[0].threads).toHaveLength(4);
    const delta = (seq: number) => ({
      type: "ig:ws" as const,
      payloads: [JSON.stringify([{ data: { slide_delta_processor: [{ __typename: "SlideUQPPCreateReaction", uq_seq_id: String(seq) }] } }])],
    });
    capture.handle(delta(19889) as unknown as HookMessage);
    expect(stale).toBe(0);
    capture.handle(delta(19895) as unknown as HookMessage);
    expect(stale).toBe(1);
  });
});
