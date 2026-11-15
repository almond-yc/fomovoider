// The Telegram session string (auth key plus data center) is a full login,
// so it never travels in the contract's Session: a "device" session carries
// only a deviceId, and the store resolves it. Convex keeps the strings
// encrypted in telegram_sessions (convex/telegram/).
export interface SessionStore {
  // The session string, or null when the session was deleted.
  load(deviceId: string): Promise<string | null>;
}

// Access hashes: Telegram needs one, besides the id, to address a user or a
// supergroup. They are learned from every result and are stable per account.
// Keys are peer keys ("user:123", "channel:456").
export interface PeerStore {
  get(deviceId: string, keys: string[]): Promise<Record<string, string>>;
  put(deviceId: string, hashes: Record<string, string>): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  readonly sessions = new Map<string, string>();
  async load(deviceId: string) {
    return this.sessions.get(deviceId) ?? null;
  }
}

export class MemoryPeerStore implements PeerStore {
  readonly hashes = new Map<string, string>();
  async get(deviceId: string, keys: string[]) {
    const out: Record<string, string> = {};
    for (const key of keys) {
      const hash = this.hashes.get(`${deviceId}|${key}`);
      if (hash !== undefined) out[key] = hash;
    }
    return out;
  }
  async put(deviceId: string, hashes: Record<string, string>) {
    for (const [key, hash] of Object.entries(hashes)) this.hashes.set(`${deviceId}|${key}`, hash);
  }
}
