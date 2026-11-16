import { afterEach, expect, test } from "vitest";
import { captureHookJs, FEED_OPERATIONS } from "./hook";

// Runs the injected hook against a minimal fake page: an XMLHttpRequest that
// records what was sent, plus document, history and location stubs.
function page() {
  const posted: any[] = [];
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  class FakeXHR {
    responseType = "";
    responseText = "";
    status = 0;
    private listeners: Record<string, (() => void)[]> = {};
    open(_method: string, _url: string) {}
    setRequestHeader(_k: string, _v: string) {}
    send(_body: string) {}
    addEventListener(type: string, fn: () => void) {
      (this.listeners[type] ??= []).push(fn);
    }
    respond(status: number, text: string) {
      this.status = status;
      this.responseText = text;
      this.listeners.load?.forEach((f) => f());
    }
  }
  const raw = { open: FakeXHR.prototype.open, setRequestHeader: FakeXHR.prototype.setRequestHeader };
  FakeXHR.prototype.open = function (this: any, method: string, url: string) {
    this._url = url;
    this._headers = {};
    return raw.open.call(this, method, url);
  };
  FakeXHR.prototype.setRequestHeader = function (this: any, k: string, v: string) {
    this._headers[k] = v;
  };
  FakeXHR.prototype.send = function (this: any, body: string) {
    sent.push({ url: this._url, headers: this._headers, body });
    if (this._autoRespond) this.respond(200, '{"data":{}}');
  };
  const win: any = {
    ReactNativeWebView: { postMessage: (m: string) => posted.push(JSON.parse(m)) },
    fetch: async () => new Response("{}"),
    addEventListener() {},
  };
  const doc = { readyState: "complete", title: "Instagram", querySelectorAll: () => [] };
  const history = { pushState() {}, replaceState() {} };
  const location = { href: "https://www.instagram.com/?variant=following" };
  new Function("window", "XMLHttpRequest", "document", "history", "location", captureHookJs(FEED_OPERATIONS, "_k"))(
    win,
    FakeXHR,
    doc,
    history,
    location,
  );
  return { win, posted, sent, FakeXHR };
}

const nativeToString = Function.prototype.toString;
afterEach(() => {
  Function.prototype.toString = nativeToString;
});

const PAGE_BODY =
  "av=1&__d=www&__dyn=abc&__csr=def&fb_dtsg=TOKEN&jazoest=123&lsd=LSD&fb_api_req_friendly_name=PolarisFeedRootPaginationCachedQuery_subscribe&variables=%7B%7D&server_timestamps=true&doc_id=29639616438977013";

test("forwards captured operations' responses and leaves the request untouched", () => {
  const { win, posted, sent, FakeXHR } = page();
  const xhr: any = new FakeXHR();
  xhr.open("POST", "/graphql/query");
  xhr.setRequestHeader("X-FB-Friendly-Name", "PolarisFeedRootPaginationCachedQuery_subscribe");
  xhr.send(PAGE_BODY);
  xhr.respond(200, '{"data":1}');
  expect(sent).toEqual([{ url: "/graphql/query", headers: { "X-FB-Friendly-Name": "PolarisFeedRootPaginationCachedQuery_subscribe" }, body: PAGE_BODY }]);
  expect(posted.filter((m) => m.type === "ig:response")).toEqual([
    { type: "ig:response", operation: "PolarisFeedRootPaginationCachedQuery_subscribe", status: 200, body: '{"data":1}' },
  ]);
  const other: any = new FakeXHR();
  other.open("POST", "/graphql/query");
  other.send(PAGE_BODY.replace("PolarisFeedRootPaginationCachedQuery_subscribe", "IGDBadgeCountOffMsysQuery"));
  other.respond(200, "{}");
  expect(posted.filter((m) => m.type === "ig:response")).toHaveLength(1);
  expect(Object.keys(win)).not.toContain("_k");
});

test("wrapped functions report native source", () => {
  const { win, FakeXHR } = page();
  expect(Function.prototype.toString.call(FakeXHR.prototype.send)).not.toContain("operation(");
  expect(Function.prototype.toString.call(win.fetch)).not.toContain("ig:response");
});

test("the story query copies the page's latest request and swaps in its own operation", async () => {
  const { win, sent, posted, FakeXHR } = page();
  await expect(win._k.stories(["1"], "1", 1)).rejects.toThrow("no page request");
  const xhr: any = new FakeXHR();
  xhr.open("POST", "/graphql/query");
  xhr.setRequestHeader("X-FB-Friendly-Name", "PolarisFeedRootPaginationCachedQuery_subscribe");
  xhr.setRequestHeader("X-Root-Field-Name", "xdt_api__v1__feed__timeline__connection");
  xhr.setRequestHeader("X-CSRFToken", "csrf");
  xhr.send(PAGE_BODY);
  FakeXHR.prototype["_autoRespond" as never] = true as never;
  const status = await win._k.stories(["11", "22", "33"], "11", 3);
  expect(status).toBe(200);
  const own = sent.at(-1)!;
  expect(own.url).toBe("/graphql/query");
  expect(own.headers).toEqual({
    "X-FB-Friendly-Name": "PolarisStoriesV3ReelPageGalleryQuery",
    "X-Root-Field-Name": "xdt_api__v1__feed__reels_media__connection",
    "X-CSRFToken": "csrf",
  });
  const params = new URLSearchParams(own.body);
  expect(params.get("fb_dtsg")).toBe("TOKEN");
  expect(params.get("__dyn")).toBe("abc");
  expect(params.get("fb_api_req_friendly_name")).toBe("PolarisStoriesV3ReelPageGalleryQuery");
  expect(params.get("doc_id")).toBe("29088280257466613");
  expect(JSON.parse(params.get("variables")!)).toMatchObject({ initial_reel_id: "11", reel_ids: ["11", "22", "33"], first: 3 });
  expect(posted.at(-1)).toMatchObject({ type: "ig:response", operation: "PolarisStoriesV3ReelPageGalleryQuery", status: 200 });
});
