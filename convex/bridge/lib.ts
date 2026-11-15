import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

// The account and its device, only when the account's device session points at
// a bridge_devices row that belongs to the account's user. Checked on every
// use of the session, not just at pairing.
export async function loadBridgeAccount(ctx: Pick<QueryCtx, "db">, accountId: Id<"connectedAccounts">) {
  const account = await ctx.db.get(accountId);
  if (!account || account.session.kind !== "device") throw new Error("Not a bridge account");
  const deviceId = ctx.db.normalizeId("bridge_devices", account.session.deviceId);
  const device = deviceId && (await ctx.db.get(deviceId));
  if (!device || device.userId !== account.userId || device.accountId !== accountId || device.platform !== account.platform) {
    throw new Error("Not a bridge account");
  }
  return { account, device };
}

// Calls to the bridge host's adapter. BRIDGE_URL is its base URL and
// BRIDGE_SECRET the bearer token both sides share.

export function bridgeSecret() {
  const secret = process.env.BRIDGE_SECRET;
  if (!secret) throw new Error("BRIDGE_SECRET is not set");
  return secret;
}

export async function callBridge<T>(path: string, body: unknown): Promise<T> {
  const url = process.env.BRIDGE_URL;
  if (!url) throw new Error("BRIDGE_URL is not set");
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridgeSecret()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(`Bridge ${path} failed: ${json.error ?? response.status}`);
  return json as T;
}

// Constant-time comparison for the bearer token (no node:crypto here).
export function sameSecret(given: string, expected: string) {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
