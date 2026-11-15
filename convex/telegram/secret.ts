// AES-256-GCM for Telegram session strings at rest. TELEGRAM_SESSION_KEY is
// 32 random bytes, base64 (`openssl rand -base64 32`). Rotating it logs every
// Telegram account out of Fomovoider: stored sessions can't be decrypted.
const VERSION = "v1";

async function key(): Promise<CryptoKey> {
  const raw = process.env.TELEGRAM_SESSION_KEY;
  const bytes = raw ? Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)) : new Uint8Array();
  if (bytes.length !== 32) throw new Error("TELEGRAM_SESSION_KEY must be 32 bytes, base64 (openssl rand -base64 32)");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export async function encryptSecret(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(plain)));
  return [VERSION, toB64(iv), toB64(sealed)].join(":");
}

export async function decryptSecret(secret: string): Promise<string> {
  const [version, iv, sealed] = secret.split(":");
  if (version !== VERSION || !iv || !sealed) throw new Error("Unrecognized Telegram secret format");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, await key(), fromB64(sealed));
  return new TextDecoder().decode(plain);
}
