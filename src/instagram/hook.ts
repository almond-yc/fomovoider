// JavaScript injected into the hidden instagram.com web view before the page's
// own scripts run. It never sends, changes or delays a request: it reads
// copies of the responses instagram.com's own code asked for and forwards
// the few the connector parses to React Native. Cookies and request headers
// are never read or forwarded.

// GraphQL operations (fb_api_req_friendly_name) whose responses we parse.
export const CAPTURED_OPERATIONS = [
  "PolarisFeedRootPaginationCachedQuery_subscribe",
  "PolarisFeedRootPaginationCachedQuery",
  "PolarisStoriesV3ReelPageGalleryQuery",
  "PolarisStoriesV3ReelPageGalleryPaginationQuery",
];

// Server-rendered data keys the first page carries inline.
export const SSR_KEYS = ["xdt_api__v1__feed__timeline__connection", "xdt_api__v1__feed__reels_tray", "xdt_viewer"];

export type HookMessage =
  | { type: "ig:response"; operation: string; status: number; body: string }
  | { type: "ig:ssr"; scripts: string[] }
  | { type: "ig:location"; href: string; title: string }
  | { type: "ig:result"; id: number; ok: boolean; value: string };

export const CAPTURE_HOOK_JS = String.raw`(function () {
  if (window.__fomoHooked) return;
  window.__fomoHooked = true;
  var OPS = ${JSON.stringify(CAPTURED_OPERATIONS)};
  var KEYS = ${JSON.stringify(SSR_KEYS)};
  function send(msg) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } catch (e) {}
  }
  function operation(body) {
    if (body && typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) body = body.toString();
    if (typeof body !== "string") return null;
    var m = body.match(/(?:^|&)fb_api_req_friendly_name=([^&]+)/);
    var name = m ? decodeURIComponent(m[1]) : null;
    return name && OPS.indexOf(name) >= 0 ? name : null;
  }
  var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__fomoUrl = String(url);
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var op = /\/graphql\/query|\/api\/graphql/.test(this.__fomoUrl || "") ? operation(body) : null;
    if (op) {
      var xhr = this;
      xhr.addEventListener("load", function () {
        try {
          var text = xhr.responseType === "" || xhr.responseType === "text" ? xhr.responseText : null;
          if (text) send({ type: "ig:response", operation: op, status: xhr.status, body: text });
        } catch (e) {}
      });
    }
    return XS.apply(this, arguments);
  };
  var F = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var op = /\/graphql\/query|\/api\/graphql/.test(url) ? operation(init && init.body) : null;
    var p = F.apply(this, arguments);
    if (op) {
      p.then(function (res) {
        res.clone().text().then(function (text) {
          send({ type: "ig:response", operation: op, status: res.status, body: text });
        }, function () {});
      }, function () {});
    }
    return p;
  };
  function ssr() {
    var out = [];
    var nodes = document.querySelectorAll('script[type="application/json"]');
    for (var i = 0; i < nodes.length; i++) {
      var t = nodes[i].textContent || "";
      for (var k = 0; k < KEYS.length; k++) if (t.indexOf(KEYS[k]) >= 0) { out.push(t); break; }
    }
    if (out.length) send({ type: "ig:ssr", scripts: out });
  }
  var last = "";
  function where() {
    if (location.href === last) return;
    last = location.href;
    send({ type: "ig:location", href: location.href, title: document.title });
  }
  var PS = history.pushState, RS = history.replaceState;
  history.pushState = function () { var r = PS.apply(this, arguments); where(); return r; };
  history.replaceState = function () { var r = RS.apply(this, arguments); where(); return r; };
  window.addEventListener("popstate", where);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { ssr(); where(); });
  else { ssr(); where(); }
})();
true;`;
