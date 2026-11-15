import { defineTable } from "convex/server";
import { v } from "convex/values";

export const vBridgePlatform = v.union(v.literal("whatsapp"), v.literal("messenger"));

// Bridge-host tables, spread into convex/schema.ts. The bridge host keeps
// every secret (WhatsApp keys, Meta cookies); Convex only tracks pairing.
export const bridgeTables = {
  // One per user and bridged platform. A connected account's session is
  // { kind: "device", deviceId } pointing here.
  bridge_devices: defineTable({
    userId: v.id("users"),
    platform: vBridgePlatform,
    accountId: v.optional(v.id("connectedAccounts")),
    status: v.union(
      v.literal("pairing"),
      v.literal("connected"),
      v.literal("failed"),
      v.literal("logged_out"),
    ),
    // While pairing: the QR payload to render, or the pairing code to type
    // into the phone ("Link with phone number").
    flow: v.optional(v.union(v.literal("qr"), v.literal("code"))),
    code: v.optional(v.string()),
    error: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_userId_and_platform", ["userId", "platform"])
    .index("by_accountId", ["accountId"]),
};
