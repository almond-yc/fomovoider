import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { vMessage } from "../lib/validators";
import type { Infer } from "convex/values";
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
  // Stores the message as pending and queues it for the phone, which sends it
  // through instagram.com and flips it to sent or failed (instagram/send.ts).
  instagram: {
    capabilities: { feed: true, chats: true, sendMessage: true, sendMedia: false, reply: false },
    send: (ctx, account, conversationId, text) =>
      ctx.runMutation(internal.instagram.send.message, { accountId: account._id, conversationId, text }),
    markRead: async (ctx, account, conversationId) => {
      await ctx.runMutation(internal.instagram.send.markRead, { accountId: account._id, conversationId });
    },
  },
};

// Why a message can't be sent to this conversation right now, or null when it can.
// serverChatKeys: the account's X Chat keys are saved on the server
// (x/chatKeys hasActiveChatKeys), so a locked X Chat row can still be sent to.
export function sendBlocker(
  conversation: Pick<Doc<"conversations">, "platform" | "unavailable">,
  account: Pick<Doc<"connectedAccounts">, "status"> | null,
  serverChatKeys = false,
): ConnectorError | null {
  const sendsLocked = serverChatKeys && conversation.platform === "x" && conversation.unavailable?.reason === "locked";
  if (conversation.unavailable && !sendsLocked) return { kind: "unsupported", capability: "sendMessage" };
  if (!CHAT_PLATFORMS[conversation.platform]?.capabilities.sendMessage) {
    return { kind: "unsupported", capability: "sendMessage" };
  }
  if (!account || account.status === "expired") return { kind: "session_expired" };
  if (account.status === "pending" || account.status === "resetting") {
    return { kind: "platform", message: "This account is still connecting. Try again in a minute." };
  }
  return null;
}
