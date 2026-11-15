import type { ChatEventRow, ChatKeyContext, ChatSigningKey } from "../../connectors/x/chat";
import type { EngineErrorKind } from "./core";

// Messages between the app and the hidden WebView that runs the Chat XDK.
// The passcode crosses once, in "unlock"; keys never cross back.
export type BridgeRequest =
  | { id: number; op: "unlock"; pin: string; context: ChatKeyContext }
  | { id: number; op: "setSigningKeys"; keys: ChatSigningKey[] }
  | { id: number; op: "decrypt"; conversationId: string; rows: ChatEventRow[]; keyEvents: string[] }
  | { id: number; op: "encrypt"; conversationId: string; text: string }
  | { id: number; op: "lock" };

export type BridgeResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { kind: EngineErrorKind; message: string; guessesRemaining?: number } };

// Id 0 is the engine's "ready" signal after the WASM loaded.
export const READY_ID = 0;
