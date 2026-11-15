import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

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
