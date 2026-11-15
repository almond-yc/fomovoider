// The connector speaks plain-JSON TL: every object carries its TL constructor
// or method name in `_` (`"messages.getHistory"`, `"inputPeerUser"`), `long`
// values are decimal strings and `bytes` are Uint8Arrays. gramjs.ts converts
// this to GramJS objects and back; tests and mock mode answer it from fixtures.
export interface TlObject {
  _: string;
  [field: string]: unknown;
}

export interface TelegramClient {
  invoke<T = any>(request: TlObject): Promise<T>;
  // Moves this client (and its session) to another data center; QR login
  // needs it for auth.loginTokenMigrateTo.
  switchDc(dcId: number): Promise<void>;
  // SRP proof for auth.checkPassword from account.getPassword's result.
  passwordCheck(password: TlObject, plain: string): Promise<TlObject>;
  // The session string as it stands now (the auth key and data center).
  exportSession(): string;
  disconnect(): Promise<void>;
}

export interface TelegramTransport {
  // An empty session string starts a fresh, unauthorized session (for login).
  connect(session: string): Promise<TelegramClient>;
}

// An RPC error from Telegram, by its raw message (`FLOOD_WAIT_30`,
// `AUTH_KEY_UNREGISTERED`, ...). Transports throw this; anything else that
// fails a call counts as a network failure.
export class TelegramRpcError extends Error {
  constructor(
    readonly code: number,
    readonly errorMessage: string,
  ) {
    super(`Telegram RPC error ${code}: ${errorMessage}`);
    this.name = "TelegramRpcError";
  }
}
