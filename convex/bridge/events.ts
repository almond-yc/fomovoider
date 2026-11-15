import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { vConversationInput, vMessageInput, vPerson } from "../lib/validators";
import { loadBridgeAccount } from "./lib";
import { vPairingStep } from "./schema";

const vAccount = { accountId: v.id("connectedAccounts") };
// The pairing attempt (bridge_devices row) a login result belongs to.
const vAttempt = { ...vAccount, deviceId: v.string() };

// Everything the bridge host reports, as one validated union.
export const vBridgeEvent = v.union(
  v.object({ ...vAttempt, kind: v.literal("pairing"), step: vPairingStep }),
  v.object({ ...vAttempt, kind: v.literal("connected"), me: vPerson }),
  v.object({ ...vAttempt, kind: v.literal("failed"), error: v.string() }),
  v.object({ ...vAccount, kind: v.literal("logged_out"), reason: v.optional(v.string()) }),
  v.object({
    ...vAccount,
    kind: v.literal("sync"),
    conversations: v.array(vConversationInput),
    messages: v.array(vMessageInput),
  }),
);

// Applies one bridge event in a single transaction, for bridge accounts only
// (see loadBridgeAccount). Login results of a superseded pairing attempt are
// ignored. Returns "not_ready" for a sync the account can't take yet (identity
// unconfirmed, or an old identity's data still being purged): the bridge host
// retries those.
export const apply = internalMutation({
  args: { event: vBridgeEvent },
  returns: v.union(v.null(), v.literal("not_ready")),
  handler: async (ctx, { event }) => {
    const { accountId } = event;
    const { account, device } = await loadBridgeAccount(ctx, accountId);
    if ("deviceId" in event && event.deviceId !== device._id) return null;
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
        // Stragglers after a logout must not make the account look active.
        if (device.status === "logged_out") return null;
        if (account.status === "pending" || account.status === "resetting") return "not_ready";
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
