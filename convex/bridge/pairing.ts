import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalMutation, query } from "../_generated/server";
import { requireUserId } from "../lib/auth";
import { callBridge } from "./lib";
import { vBridgePlatform, vPairingStep } from "./schema";

// Starts pairing WhatsApp or Messenger through the bridge host: the contract's
// "steps" login, run on the server. The app watches pairing.status and shows
// `step`: a QR code ("qr", refreshed about every 20 s) or a code to type into
// WhatsApp > Linked devices > Link with phone number ("showCode", for
// method "phone"), until status is "connected".
export const start = action({
  args: {
    platform: vBridgePlatform,
    input: v.union(v.object({ method: v.literal("qr") }), v.object({ method: v.literal("phone"), phone: v.string() })),
  },
  returns: v.null(),
  handler: async (ctx, { platform, input }) => {
    const accountId = await ctx.runMutation(internal.bridge.pairing.begin, { platform });
    try {
      const step = await callBridge<{ kind: "qr"; url: string; expiresAt: string } | { kind: "showCode"; code: string; expiresAt: string }>(
        "/v1/login",
        { accountId, platform, ...input },
      );
      await ctx.runMutation(internal.bridge.events.apply, { event: { accountId, kind: "pairing", step } });
    } catch (error) {
      await ctx.runMutation(internal.bridge.events.apply, {
        event: { accountId, kind: "failed", error: (error as Error).message },
      });
      throw error;
    }
    return null;
  },
});

export const status = query({
  args: { platform: vBridgePlatform },
  returns: v.union(
    v.null(),
    v.object({
      status: v.union(v.literal("pairing"), v.literal("connected"), v.literal("failed"), v.literal("logged_out")),
      step: v.optional(vPairingStep),
      error: v.optional(v.string()),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, { platform }) => {
    const userId = await requireUserId(ctx);
    const device = await ctx.db
      .query("bridge_devices")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId).eq("platform", platform))
      .unique();
    if (!device) return null;
    const { status, step, error, updatedAt } = device;
    return { status, step, error, updatedAt };
  },
});

// A fresh device row for the signed-in user (a re-pair replaces the old one)
// and its device session. The row is created here for this user, which is the
// ownership check connectDevice requires.
export const begin = internalMutation({
  args: { platform: vBridgePlatform },
  returns: v.id("connectedAccounts"),
  handler: async (ctx, { platform }) => {
    const userId = await requireUserId(ctx);
    const previous = await ctx.db
      .query("bridge_devices")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId).eq("platform", platform))
      .collect();
    for (const device of previous) await ctx.db.delete(device._id);
    const deviceId = await ctx.db.insert("bridge_devices", { userId, platform, status: "pairing", updatedAt: Date.now() });
    const accountId = await ctx.runMutation(internal.accounts.connectDevice, { userId, platform, deviceId });
    await ctx.db.patch(deviceId, { accountId });
    return accountId;
  },
});
