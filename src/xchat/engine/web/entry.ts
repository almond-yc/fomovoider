import { createChat } from "@xdevplatform/chat-xdk";
import { EngineError, type XdkChat, XChatEngine } from "../core";
import type { BridgeRequest, BridgeResponse } from "../protocol";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    __xchat?: { receive(request: BridgeRequest): void };
  }
}

const engine = new XChatEngine(async ({ juiceboxConfig, getAuthToken }) => (await createChat({ juiceboxConfig, getAuthToken })) as unknown as XdkChat);

function post(message: BridgeResponse) {
  window.ReactNativeWebView?.postMessage(JSON.stringify(message));
}

async function handle(req: BridgeRequest): Promise<unknown> {
  switch (req.op) {
    case "unlock":
      await engine.unlock(req.pin, req.context);
      return null;
    case "setSigningKeys":
      engine.setSigningKeys(req.keys);
      return null;
    case "decrypt":
      return engine.decrypt(req.conversationId, req.rows, req.keyEvents);
    case "encrypt":
      return engine.encrypt(req.conversationId, req.text);
    case "lock":
      engine.lock();
      return null;
  }
}

window.__xchat = {
  receive(req) {
    handle(req).then(
      (result) => post({ id: req.id, ok: true, result }),
      (err: unknown) =>
        post({
          id: req.id,
          ok: false,
          error:
            err instanceof EngineError
              ? { kind: err.kind, message: err.message, ...(err.guessesRemaining !== undefined ? { guessesRemaining: err.guessesRemaining } : {}) }
              : { kind: "failed", message: err instanceof Error ? err.message : String(err) },
        }),
    );
  },
};

post({ id: 0, ok: true, result: "ready" });
