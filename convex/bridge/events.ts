import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { vConversationInput, vMessageInput, vPerson } from "../lib/validators";
import { loadBridgeAccount } from "./lib";
import { vPairingStep } from "./schema";

const vAccount = { accountId: v.id("connectedAccounts") };

// Everything the bridge host reports, as one validated union.
export const vBridgeEvent = v.union(
  v.object({ ...vAccount, kind: v.literal("pairing"), step: vPairingStep }),
  v.object({ ...vAccount, kind: v.literal("connected"), me: vPerson }),
  v.object({ ...vAccount, kind: v.literal("failed"), error: v.string() }),
  v.object({ ...vAccount, kind: v.literal("logged_out"), reason: v.optional(v.string()) }),
  v.object({
    ...vAccount,
    kind: v.literal("sync"),
    conversations: v.array(vConversationInput),
    messages: v.array(vMessageInput),
  }),
);

// Applies one bridge event in a single transaction, for bridge accounts only
// (see loadBridgeAccount).
export const apply = internalMutation({
  args: { event: vBridgeEvent },
  returns: v.null(),
  handler: async (ctx, { event }) => {
    const { accountId } = event;
    const { device } = await loadBridgeAccount(ctx, accountId);
    const updatedAt = Date.now();
    switch (event.kind) {
      case "pairing":
        await ctx.db.patch(device._id, { status: "pairing", step: event.step, error: undefined, updatedAt });
        return null;
      case "connected":
        await ctx.runMutation(internal.accounts.verifyIdentity, { accountId, me: event.me });
        await ctx.db.patch(device._id, { status: "connected", step: undefined, error: undefined, updatedAt });
        return null;
      case "failed":
        await ctx.db.patch(device._id, { status: "failed", step: undefined, error: event.error, updatedAt });
        return null;
      case "logged_out":
        await ctx.db.patch(device._id, { status: "logged_out", error: event.reason, updatedAt });
        await ctx.runMutation(internal.accounts.recordSync, { accountId, error: { kind: "session_expired" } });
        return null;
      case "sync":
        if (event.conversations.length > 0) {
          await ctx.runMutation(internal.ingest.upsertConversations, { accountId, conversations: event.conversations });
        }
        if (event.messages.length > 0) {
          await ctx.runMutation(internal.ingest.upsertMessages, { accountId, messages: event.messages });
        }
        await ctx.runMutation(internal.accounts.recordSync, { accountId });
        return null;
    }
  },
});
