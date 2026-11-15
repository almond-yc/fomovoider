import { v } from "convex/values";
import { api, internal } from "../_generated/api";
import { action, internalMutation, query } from "../_generated/server";
import { requireUserId } from "../lib/auth";
import { callBridge } from "./lib";
import { vBridgePlatform } from "./schema";

// Starts pairing WhatsApp or Messenger through the bridge host. The app then
// watches pairing.status: it renders `code` as a QR (flow "qr"), or shows it
// as the code to type into WhatsApp > Linked devices > Link with phone
// number (flow "code", started with a phone number), until status is
// "connected". The QR refreshes every ~20 s while status stays "pairing".
export const start = action({
  args: { platform: vBridgePlatform, phone: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { platform, phone }) => {
    const deviceId = await ctx.runMutation(internal.bridge.pairing.createDevice, { platform });
    const accountId = await ctx.runMutation(api.accounts.connect, {
      session: { platform, kind: "device", deviceId },
    });
    await ctx.runMutation(internal.bridge.pairing.attach, { deviceId, accountId });
    try {
      const first = await callBridge<{ flow: "qr" | "code"; code: string }>("/v1/login", {
        accountId,
        platform,
        flow: phone ? "phone" : "qr",
        phone,
      });
      await ctx.runMutation(internal.bridge.events.apply, {
        event: { accountId, kind: "pairing", ...first },
      });
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
      flow: v.optional(v.union(v.literal("qr"), v.literal("code"))),
      code: v.optional(v.string()),
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
    const { status, flow, code, error, updatedAt } = device;
    return { status, flow, code, error, updatedAt };
  },
});

// A fresh device row for the signed-in user; a re-pair replaces the old one.
export const createDevice = internalMutation({
  args: { platform: vBridgePlatform },
  returns: v.id("bridge_devices"),
  handler: async (ctx, { platform }) => {
    const userId = await requireUserId(ctx);
    const previous = await ctx.db
      .query("bridge_devices")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId).eq("platform", platform))
      .collect();
    for (const device of previous) await ctx.db.delete(device._id);
    return await ctx.db.insert("bridge_devices", { userId, platform, status: "pairing", updatedAt: Date.now() });
  },
});

export const attach = internalMutation({
  args: { deviceId: v.id("bridge_devices"), accountId: v.id("connectedAccounts") },
  returns: v.null(),
  handler: async (ctx, { deviceId, accountId }) => {
    await ctx.db.patch(deviceId, { accountId });
    return null;
  },
});
