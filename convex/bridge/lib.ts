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
