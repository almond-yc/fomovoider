import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { vMessage } from "../lib/validators";
import { epochMs } from "../lib/normalize";
import type { Message } from "../../src/connectors/types";
import { callBridge } from "./lib";

// For messages.send: sends text through the bridge host and stores the sent
// message. Throws when the bridge or the platform refuses it; never retried.
export const send = internalAction({
  args: { accountId: v.id("connectedAccounts"), conversationId: v.string(), text: v.string() },
  returns: vMessage,
  handler: async (ctx, { accountId, conversationId, text }) => {
    const message = await callBridge<Message>("/v1/send", { accountId, conversationId, text });
    await ctx.runMutation(internal.ingest.upsertMessages, { accountId, messages: [message] });
    return { ...message, sentAt: epochMs(message.sentAt) };
  },
});

export const markRead = internalAction({
  args: { accountId: v.id("connectedAccounts"), conversationId: v.string() },
  returns: v.null(),
  handler: async (_ctx, { accountId, conversationId }) => {
    await callBridge("/v1/read", { accountId, conversationId });
    return null;
  },
});
