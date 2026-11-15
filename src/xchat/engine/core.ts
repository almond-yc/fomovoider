import type { ChatEventRow, ChatKeyContext, ChatSendPayload, ChatSigningKey, DecryptOutcome, DecryptedChatEvent } from "../../connectors/x/chat";
import { realmTokenFrom } from "../../connectors/x/chat/juicebox";

// The slice of the Chat XDK's ChatWithJuicebox the engine uses.
export interface XdkChat {
  unlock(pin: Uint8Array): Promise<void>;
  setIdentity(params: { userId: string; signingKeyVersion: string }): void;
  setSigningKeys(keys: ChatSigningKey[]): void;
  setCacheKeys(enabled: boolean): void;
  decryptEvents(params: { events: string[] }): {
    events: { event: DecryptedChatEvent & { conversationId?: string | null }; originalB64?: string }[];
    errors: Record<string, string>;
  };
  encryptMessage(params: { conversationId: string; text: string }): {
    messageId: string;
    encodedMessageCreateEvent: string;
    encodedMessageEventSignature: string;
    xdkVersion?: string;
  };
  lock(): void;
  free?(): void;
}

export type CreateXdkChat = (opts: { juiceboxConfig: string; getAuthToken: (realmId: string) => Promise<string> }) => Promise<XdkChat>;

export type EngineErrorKind = "invalidPin" | "notSetUp" | "locked" | "noKey" | "failed";

export class EngineError extends Error {
  constructor(
    readonly kind: EngineErrorKind,
    message: string,
    readonly guessesRemaining?: number,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

// Holds the unlocked X Chat keys for one app session. It runs inside the
// WebView (where the XDK's WASM works) and is also unit-tested in Node.
// Nothing it holds ever leaves it: callers get ciphertext out and plaintext
// back, never keys or the passcode.
export class XChatEngine {
  private chat: XdkChat | null = null;
  // Our "x:<a>-<b>" ids to the XDK's own conversation ids, learned from
  // decrypted events, so encryptMessage finds the cached key.
  private readonly sdkIds = new Map<string, string>();

  constructor(private readonly create: CreateXdkChat) {}

  get unlocked(): boolean {
    return this.chat !== null;
  }

  async unlock(pin: string, context: ChatKeyContext): Promise<void> {
    if (!context.juiceboxConfig || !context.signingKeyVersion) {
      throw new EngineError("notSetUp", "This X account hasn't set up X Chat yet. Set a passcode in the X app first.");
    }
    const config = context.juiceboxConfig;
    const chat = await this.create({
      juiceboxConfig: config,
      getAuthToken: async (realmId) => {
        const token = realmTokenFrom(config, realmId);
        if (!token) throw new EngineError("failed", "X didn't send a token for one of the key backup servers");
        return token;
      },
    });
    const pinBytes = new TextEncoder().encode(pin);
    try {
      await chat.unlock(pinBytes);
    } catch (err) {
      chat.free?.();
      const e = err as { kind?: string; guessesRemaining?: number | null; message?: string };
      if (e.kind === "invalidPin") {
        throw new EngineError("invalidPin", "Wrong passcode.", e.guessesRemaining ?? undefined);
      }
      throw new EngineError("failed", e.message ?? "Couldn't unlock X Chat");
    } finally {
      pinBytes.fill(0);
    }
    this.adopt(chat, { meId: context.meId, signingKeyVersion: context.signingKeyVersion, signingKeys: context.signingKeys });
  }

  // Takes a chat that already holds the user's keys: one unlocked above, or
  // on the server one that imported them (chat-xdk-server's importKeys).
  adopt(chat: XdkChat, context: { meId: string; signingKeyVersion: string; signingKeys: ChatSigningKey[] }): void {
    chat.setIdentity({ userId: context.meId, signingKeyVersion: context.signingKeyVersion });
    chat.setSigningKeys(context.signingKeys);
    chat.setCacheKeys(true);
    this.lock();
    this.chat = chat;
  }

  setSigningKeys(keys: ChatSigningKey[]): void {
    this.require().setSigningKeys(keys);
  }

  // Decrypts one conversation's stored rows; the outcome list lines up with
  // `rows`. Key-change events go first so their keys are available.
  decrypt(conversationId: string, rows: ChatEventRow[], keyEvents: string[]): DecryptOutcome[] {
    const chat = this.require();
    const batch = [...keyEvents, ...[...rows].reverse().map((r) => r.encodedEvent)];
    const result = chat.decryptEvents({ events: batch });
    const byB64 = new Map<string, DecryptedChatEvent>();
    for (const { event, originalB64 } of result.events) {
      if (originalB64) byB64.set(originalB64, event);
      if (event.conversationId && !this.sdkIds.has(conversationId)) this.sdkIds.set(conversationId, event.conversationId);
    }
    const firstRow = keyEvents.length;
    return rows.map((row, i): DecryptOutcome => {
      const batchIndex = firstRow + rows.length - 1 - i;
      const error = result.errors[String(batchIndex)];
      if (error !== undefined) return { error };
      const event = byB64.get(row.encodedEvent);
      return event ? { event: plainEvent(event) } : { error: "Not returned by the decryptor" };
    });
  }

  encrypt(conversationId: string, text: string): ChatSendPayload {
    const chat = this.require();
    const sdkId = this.sdkIds.get(conversationId);
    if (!sdkId) throw new EngineError("noKey", "Open this chat once so its encryption key loads, then send.");
    const p = chat.encryptMessage({ conversationId: sdkId, text });
    return {
      messageId: p.messageId,
      encodedMessageCreateEvent: p.encodedMessageCreateEvent,
      encodedMessageEventSignature: p.encodedMessageEventSignature,
      ...(p.xdkVersion ? { xdkVersion: p.xdkVersion } : {}),
    };
  }

  lock(): void {
    if (!this.chat) return;
    this.chat.lock();
    this.chat.free?.();
    this.chat = null;
    this.sdkIds.clear();
  }

  private require(): XdkChat {
    if (!this.chat) throw new EngineError("locked", "X Chat is locked");
    return this.chat;
  }
}

// Only the fields the mappers read cross the bridge.
function plainEvent(e: DecryptedChatEvent): DecryptedChatEvent {
  const content = e.content
    ? {
        ...(e.content.contentType !== undefined ? { contentType: e.content.contentType } : {}),
        ...(e.content.text !== undefined ? { text: e.content.text } : {}),
        ...(e.content.updatedText !== undefined ? { updatedText: e.content.updatedText } : {}),
        ...(e.content.targetMessageSequenceId !== undefined ? { targetMessageSequenceId: e.content.targetMessageSequenceId } : {}),
        ...(e.content.attachments?.length ? { attachments: e.content.attachments.map(() => ({})) } : {}),
      }
    : null;
  return {
    type: e.type,
    senderId: e.senderId ?? null,
    createdAtMsec: e.createdAtMsec ?? null,
    content,
    attachments: e.attachments?.length ? e.attachments.map(() => ({})) : null,
  };
}
