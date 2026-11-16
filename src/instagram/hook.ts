// JavaScript injected into the hidden instagram.com web view before the page's
// own scripts run. It reads copies of the responses instagram.com's own code
// asked for and forwards the few the connector parses to React Native. It
// never changes or delays the page's requests, and never reads cookies.
//
// The one request it can send itself is the story gallery query
// (window[key].stories): opening the story viewer would send "seen"
// receipts, so story items are fetched with the page's own query, built from
// the parameters and headers of the page's latest real GraphQL request
// (FOMO-23 spike, handoffs/instagram-webview-spike.md).

// GraphQL operations (fb_api_req_friendly_name) the feed and story parsers
// read. Other plugins (DMs) pass their own to captureHookJs.
export const FEED_OPERATIONS = [
  "PolarisFeedRootPaginationCachedQuery_subscribe",
  "PolarisFeedRootPaginationCachedQuery",
  "PolarisStoriesV3ReelPageGalleryQuery",
  "PolarisStoriesV3ReelPageGalleryPaginationQuery",
  "PolarisStoriesV3TrayContainerQuery",
];

// Server-rendered data keys the first page carries inline.
export const SSR_KEYS = ["xdt_api__v1__feed__timeline__connection", "xdt_api__v1__feed__reels_tray", "xdt_viewer"];

export const STORY_QUERY = {
  name: "PolarisStoriesV3ReelPageGalleryQuery",
  rootField: "xdt_api__v1__feed__reels_media__connection",
  // Current on 2026-11-15; the hook prefers the id from the loaded bundle.
  fallbackDocId: "29088280257466613",
};

export type HookMessage =
  | { type: "ig:response"; operation: string; status: number; body: string }
  | { type: "ig:ssr"; scripts: string[] }
  | { type: "ig:location"; href: string; title: string }
  | { type: "ig:result"; id: number; ok: boolean; value: string };

// key: a per-session property name under which the hook exposes its story
// query to scripts the host runs, so no fixed global marks the page.
export const captureHookJs = (operations: string[], key: string) => String.raw`(function () {
  var OPS = ${JSON.stringify(operations)};
  var KEYS = ${JSON.stringify(SSR_KEYS)};
  var STORY = ${JSON.stringify(STORY_QUERY)};
  var bridge = window.ReactNativeWebView;
  function post(msg) {
    try { (bridge || window.ReactNativeWebView).postMessage(JSON.stringify(msg)); } catch (e) {}
  }
  // Wrapped functions keep reporting the original's native source.
  var FTS = Function.prototype.toString, masked = new WeakMap();
  function mask(wrapper, original) { masked.set(wrapper, original); return wrapper; }
  Function.prototype.toString = mask(function toString() {
    return FTS.call(masked.get(this) || this);
  }, FTS);
  function bodyText(body) {
    if (body && typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body.toString();
    return typeof body === "string" ? body : null;
  }
  function operation(body) {
    var m = body && body.match(/(?:^|&)fb_api_req_friendly_name=([^&]+)/);
    var name = m ? decodeURIComponent(m[1]) : null;
    return name && OPS.indexOf(name) >= 0 ? name : null;
  }
  var isGraphql = function (url) { return /\/graphql\/query|\/api\/graphql/.test(url || ""); };
  var template = null, meta = new WeakMap(), own = new WeakSet();
  var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send, XH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = mask(function open(method, url) {
    meta.set(this, { url: String(url), headers: {} });
    return XO.apply(this, arguments);
  }, XO);
  XMLHttpRequest.prototype.setRequestHeader = mask(function setRequestHeader(k, v) {
    var m = meta.get(this);
    if (m) m.headers[k] = v;
    return XH.apply(this, arguments);
  }, XH);
  XMLHttpRequest.prototype.send = mask(function send(body) {
    var m = meta.get(this) || {};
    var text = isGraphql(m.url) ? bodyText(body) : null;
    if (text && !own.has(this) && /(?:^|&)fb_dtsg=/.test(text)) template = { url: m.url, headers: m.headers, body: text };
    var op = text ? operation(text) : null;
    if (op) {
      var xhr = this;
      xhr.addEventListener("load", function () {
        try {
          var t = xhr.responseType === "" || xhr.responseType === "text" ? xhr.responseText : null;
          if (t) post({ type: "ig:response", operation: op, status: xhr.status, body: t });
        } catch (e) {}
      });
    }
    return XS.apply(this, arguments);
  }, XS);
  var F = window.fetch;
  window.fetch = mask(function fetch(input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var text = isGraphql(url) ? bodyText(init && init.body) : null;
    var op = text ? operation(text) : null;
    var p = F.apply(this, arguments);
    if (op) {
      p.then(function (res) {
        res.clone().text().then(function (t) {
          post({ type: "ig:response", operation: op, status: res.status, body: t });
        }, function () {});
      }, function () {});
    }
    return p;
  }, F);
  function docId() {
    try {
      var id = window.require && window.require(STORY.name + "_instagramRelayOperation");
      if (typeof id === "string" && /^\d+$/.test(id)) return id;
    } catch (e) {}
    return STORY.fallbackDocId;
  }
  // One story gallery query for the given tray reel ids, sent like the page's
  // own: same endpoint, headers and form parameters as its latest GraphQL
  // request, with this query's name, root field, doc id and variables.
  function stories(reelIds, initialReelId, first) {
    return new Promise(function (resolve, reject) {
      if (!template) return reject(new Error("no page request to copy yet"));
      var params = new URLSearchParams(template.body);
      params.set("fb_api_req_friendly_name", STORY.name);
      params.set("doc_id", docId());
      params.set("variables", JSON.stringify({
        initial_reel_id: initialReelId,
        reel_ids: reelIds,
        first: first,
        last: 2,
        __relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider: true
      }));
      var xhr = new XMLHttpRequest();
      own.add(xhr);
      xhr.open("POST", template.url, true);
      for (var k in template.headers) {
        var v = template.headers[k];
        if (/^x-fb-friendly-name$/i.test(k)) v = STORY.name;
        if (/^x-root-field-name$/i.test(k)) v = STORY.rootField;
        xhr.setRequestHeader(k, v);
      }
      xhr.withCredentials = true;
      xhr.addEventListener("load", function () { resolve(xhr.status); });
      xhr.addEventListener("error", function () { reject(new Error("story query failed")); });
      xhr.send(params.toString());
    });
  }
  Object.defineProperty(window, ${JSON.stringify(key)}, { value: { stories: stories }, enumerable: false });
  function ssr() {
    var out = [];
    var nodes = document.querySelectorAll('script[type="application/json"]');
    for (var i = 0; i < nodes.length; i++) {
      var t = nodes[i].textContent || "";
      for (var k = 0; k < KEYS.length; k++) if (t.indexOf(KEYS[k]) >= 0) { out.push(t); break; }
    }
    if (out.length) post({ type: "ig:ssr", scripts: out });
  }
  var last = "";
  function where() {
    if (location.href === last) return;
    last = location.href;
    post({ type: "ig:location", href: location.href, title: document.title });
  }
  var PS = history.pushState, RS = history.replaceState;
  history.pushState = mask(function pushState() { var r = PS.apply(this, arguments); where(); return r; }, PS);
  history.replaceState = mask(function replaceState() { var r = RS.apply(this, arguments); where(); return r; }, RS);
  window.addEventListener("popstate", where);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { ssr(); where(); });
  else { ssr(); where(); }
})();
true;`;
