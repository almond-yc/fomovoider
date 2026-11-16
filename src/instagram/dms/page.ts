// Scripts for the hidden instagram.com page, used by the DM plug-in.
//
// WEBSOCKET_HOOK_JS is injected before the page's own scripts (the host's
// scripts prop). It only listens: on the lightspeed socket it decodes the
// Iris sync payloads that carry DM deltas and forwards them; it never sends,
// changes or delays a frame. The rest run inside PageControl.evaluate and
// do what a person does in the web app: open a chat, type into its composer
// and tap Send, go back to the inbox.

export const INBOX_URL = "https://www.instagram.com/direct/inbox/";
export const threadUrl = (threadKey: string) => `https://www.instagram.com/direct/t/${threadKey}/`;

export type DmHookMessage = { type: "ig:ws"; payloads: string[] };

export const WEBSOCKET_HOOK_JS = String.raw`(function () {
  if (window.__fomoDmHooked || !window.WebSocket) return;
  window.__fomoDmHooked = true;
  var NativeWebSocket = window.WebSocket;
  function forward(buffer) {
    try {
      var bytes = new Uint8Array(buffer);
      if (!bytes.length || bytes[0] !== 0x0d) return;
      var text = "";
      for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
      var out = [], re = /"payload":"([A-Za-z0-9+\/=]+)"/g, m;
      while ((m = re.exec(text))) {
        var bin = atob(m[1]), raw = new Uint8Array(bin.length);
        for (var j = 0; j < bin.length; j++) raw[j] = bin.charCodeAt(j);
        var decoded = new TextDecoder("utf-8").decode(raw);
        if (decoded.indexOf("slide_delta_processor") >= 0) out.push(decoded);
      }
      if (out.length) window.ReactNativeWebView.postMessage(JSON.stringify({ type: "ig:ws", payloads: out }));
    } catch (e) {}
  }
  function HookedWebSocket(url, protocols) {
    var ws = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    if (/^wss:\/\/gateway\.instagram\.com\/ws\/lightspeed/.test(String(url))) {
      ws.addEventListener("message", function (event) {
        var data = event.data;
        if (data instanceof ArrayBuffer) forward(data);
        else if (data && typeof data.arrayBuffer === "function") data.arrayBuffer().then(forward, function () {});
      });
    }
    return ws;
  }
  HookedWebSocket.prototype = NativeWebSocket.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) { HookedWebSocket[k] = NativeWebSocket[k]; });
  window.WebSocket = HookedWebSocket;
})();
true;`;

const COMPOSER = String.raw`
  const composer = [...document.querySelectorAll('[contenteditable="true"][role="textbox"], div[contenteditable="true"]')]
    .find((el) => el.getBoundingClientRect().height > 0);
  const composerText = () => (composer ? composer.innerText.replace(/\u00a0/g, " ").replace(/\n+$/, "") : null);
`;

// Where the page is and whether a chat's composer is on screen.
export const PAGE_STATE_JS = String.raw`
  ${COMPOSER}
  return { path: location.pathname, composer: Boolean(composer), text: composerText() };
`;

// Opens a chat by tapping its row in the inbox list, as a person would.
// False when the row isn't on screen; the caller then loads the chat's URL.
export const openThreadRowJs = (threadKey: string) => String.raw`
  const link = document.querySelector(${JSON.stringify(`a[href="/direct/t/${threadKey}/"]`)});
  if (!link) return false;
  const r = link.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, clientX: r.left + r.width * 0.5, clientY: r.top + r.height * 0.5 };
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) link.dispatchEvent(new MouseEvent(type, o));
  link.click();
  return true;
`;

// Types into the open chat's composer at a person's pace (90-260 ms a
// character) through the editor's own input path. Returns the composer's
// text afterwards, or null when there's no composer.
export const typeJs = (chunk: string) => String.raw`
  ${COMPOSER}
  if (!composer) return null;
  composer.focus();
  for (const ch of ${JSON.stringify(chunk)}) {
    const key = ch === "\n" ? "Enter" : ch;
    const init = { key, bubbles: true, cancelable: true, shiftKey: ch === "\n" };
    composer.dispatchEvent(new KeyboardEvent("keydown", init));
    if (ch === "\n") document.execCommand("insertLineBreak");
    else document.execCommand("insertText", false, ch);
    composer.dispatchEvent(new KeyboardEvent("keyup", init));
    await new Promise((r) => setTimeout(r, 90 + Math.random() * 170));
  }
  return composerText();
`;

// Taps the chat's Send button once. False when there's no Send button.
export const CLICK_SEND_JS = String.raw`
  const send = [...document.querySelectorAll('[role="button"], button')]
    .find((b) => /^send$/i.test((b.getAttribute("aria-label") || b.textContent || "").trim()) && b.getBoundingClientRect().height > 0);
  if (!send) return false;
  const r = send.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, clientX: r.left + r.width * 0.5, clientY: r.top + r.height * 0.5 };
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) send.dispatchEvent(new MouseEvent(type, o));
  send.click();
  return true;
`;

export const BACK_JS = "history.back(); return true;";

// Empties the composer after a send that didn't go out, so no half-typed
// draft stays in the chat.
export const CLEAR_COMPOSER_JS = String.raw`
  ${COMPOSER}
  if (!composer) return false;
  composer.focus();
  document.execCommand("selectAll");
  document.execCommand("delete");
  return composerText() === "";
`;
