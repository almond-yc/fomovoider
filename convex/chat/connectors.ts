import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { vMessage } from "../lib/validators";
import { ConvexError, type Infer } from "convex/values";
import type { Capabilities, ConnectorError } from "../../src/connectors/types";

type StoredMessage = Infer<typeof vMessage>;

interface ChatPlatform {
  capabilities: Capabilities;
  // Sends through the platform's own send action, which stores the message
  // and moves the conversation preview. Failures throw a ConvexError
  // carrying a ConnectorError.
  send(ctx: ActionCtx, account: Doc<"connectedAccounts">, conversationId: string, text: string): Promise<StoredMessage>;
  markRead?(ctx: ActionCtx, account: Doc<"connectedAccounts">, conversationId: string): Promise<void>;
}

// Platforms the inbox can send to (and mark read), keyed by platform id. A
// connector registers here; capabilities must match its connector's own.
export const CHAT_PLATFORMS: Record<string, ChatPlatform> = {
  x: {
    capabilities: { feed: true, chats: true, sendMessage: true, sendMedia: false, reply: true },
    send: (ctx, account, conversationId, text) =>
      ctx.runAction(internal.x.send.message, { accountId: account._id, conversationId, text }),
  },
  telegram: {
    capabilities: { feed: false, chats: true, sendMessage: true, sendMedia: false, reply: false },
    send: async (ctx, account, conversationId, text) => {
      const result = await ctx.runAction(internal.telegram.sync.send, { accountId: account._id, conversationId, text });
      if (!result.ok) throw new ConvexError<ConnectorError>(result.error);
      return { ...result.message, sentAt: Date.parse(result.message.sentAt) };
    },
    markRead: async (ctx, account, conversationId) => {
      const result = await ctx.runAction(internal.telegram.sync.markRead, { accountId: account._id, conversationId });
      if (!result.ok) throw new ConvexError<ConnectorError>(result.error);
    },
  },
};

// Why a message can't be sent to this conversation right now, or null when it can.
export function sendBlocker(
  conversation: Pick<Doc<"conversations">, "platform" | "unavailable">,
  account: Pick<Doc<"connectedAccounts">, "status"> | null,
): ConnectorError | null {
  if (conversation.unavailable) return { kind: "unsupported", capability: "sendMessage" };
  if (!CHAT_PLATFORMS[conversation.platform]?.capabilities.sendMessage) {
    return { kind: "unsupported", capability: "sendMessage" };
  }
  if (!account || account.status === "expired") return { kind: "session_expired" };
  if (account.status === "pending" || account.status === "resetting") {
    return { kind: "platform", message: "This account is still connecting. Try again in a minute." };
  }
  return null;
}
