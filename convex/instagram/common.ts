import type { Doc } from "../_generated/dataModel";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The host agent's credential: a random token whose hash was stored at pairing.
export async function deviceForToken(ctx: Pick<QueryCtx, "db">, token: string): Promise<Doc<"instagram_devices">> {
  const tokenHash = await sha256Hex(token);
  const device = await ctx.db
    .query("instagram_devices")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (!device) throw new Error("Unknown device token");
  return device;
}

// The global kill switch (instagram/killSwitch:set). While it is on, no
// Instagram refresh starts anywhere and running web-view refreshes stop.
export async function killSwitch(ctx: Pick<QueryCtx, "db">) {
  const flag = await ctx.db
    .query("instagram_flags")
    .withIndex("by_name", (q) => q.eq("name", "killSwitch"))
    .unique();
  return flag?.enabled ? { reason: flag.reason } : null;
}

// Ends a device's pending and claimed runs, for example when the device
// changes driver (Mac host agent <-> app web view): the old driver's runs
// must not be picked up by the new one, nor finished by the old one.
export async function closeOpenRuns(ctx: MutationCtx, deviceId: Id<"instagram_devices">, error: string) {
  const now = Date.now();
  for (const state of ["pending", "claimed"] as const) {
    const open = await ctx.db
      .query("instagram_runs")
      .withIndex("by_deviceId_and_state_and_scheduledFor", (q) => q.eq("deviceId", deviceId).eq("state", state))
      .collect();
    for (const run of open) {
      await ctx.db.patch(run._id, { state: state === "pending" ? "skipped" : "failed", finishedAt: now, error });
    }
  }
}
