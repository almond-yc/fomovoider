import { defineTable } from "convex/server";
import { v } from "convex/values";

export const vBridgePlatform = v.union(v.literal("whatsapp"), v.literal("messenger"));

// The contract's LoginStep kinds a bridge pairing shows, with ISO dates as in
// the contract.
export const vPairingStep = v.union(
  v.object({ kind: v.literal("qr"), url: v.string(), expiresAt: v.string() }),
  v.object({ kind: v.literal("showCode"), code: v.string(), expiresAt: v.string() }),
);

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
    // While pairing: the contract LoginStep to show, a QR code or a code to
    // type into the phone ("Link with phone number").
    step: v.optional(vPairingStep),
    error: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_userId_and_platform", ["userId", "platform"])
    .index("by_accountId", ["accountId"]),
};
