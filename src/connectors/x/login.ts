import * as AuthSession from "expo-auth-session";
import * as Crypto from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import { ConnectorFailure, type Login, type Session } from "../types";
import { OAuthClient, type PkceCrypto } from "./auth";
import { API_BASE, AUTHORIZE_URL, REVOKE_PATH, SCOPES, TOKEN_PATH } from "./endpoints";

WebBrowser.maybeCompleteAuthSession();

const expoPkceCrypto: PkceCrypto = {
  randomBytes: (size) => Crypto.getRandomBytes(size),
  sha256Base64: (input) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input, { encoding: Crypto.CryptoEncoding.BASE64 }),
};

export const X_REDIRECT_URI = "fomovoider://oauth/x";

const discovery: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: AUTHORIZE_URL,
  tokenEndpoint: `${API_BASE}${TOKEN_PATH}`,
  revocationEndpoint: `${API_BASE}${REVOKE_PATH}`,
};

export interface XLoginOptions {
  clientId: string;
  redirectUri?: string;
  fetch?: typeof fetch;
}

// What the device hands to the server after X redirects back.
export interface XAuthorizationCode {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

// With exchange, the device only runs PKCE and passes the authorization code
// to exchange (the Convex action api.x.auth.connect), and login() resolves to
// what exchange returns; this is how a confidential X app keeps its secret on
// the server. Without exchange, the device swaps the code itself as a public
// client and login() resolves to the Session.
export function createXLogin<T>(opts: XLoginOptions & { exchange: (code: XAuthorizationCode) => Promise<T> }): { kind: "oauth"; login(): Promise<T> };
export function createXLogin(opts: XLoginOptions): Login;
export function createXLogin<T>(opts: XLoginOptions & { exchange?: (code: XAuthorizationCode) => Promise<T> }): { kind: "oauth"; login(): Promise<T | Session> } {
  const redirectUri = opts.redirectUri ?? X_REDIRECT_URI;
  const oauth = new OAuthClient({
    clientId: opts.clientId,
    fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
    crypto: expoPkceCrypto,
    now: Date.now,
  });
  return {
    kind: "oauth",
    async login(): Promise<T | Session> {
      const request = new AuthSession.AuthRequest({
        clientId: opts.clientId,
        redirectUri,
        scopes: SCOPES,
        responseType: AuthSession.ResponseType.Code,
        usePKCE: true,
      });
      const result = await request.promptAsync(discovery);
      if (result.type !== "success") {
        const message = result.type === "error" ? (result.error?.message ?? "X login failed") : "X login was cancelled";
        throw new ConnectorFailure({ kind: "platform", message });
      }
      if (!result.params.code || !request.codeVerifier) throw new ConnectorFailure({ kind: "platform", message: "X login returned no authorization code" });
      const code = { code: result.params.code, codeVerifier: request.codeVerifier, redirectUri };
      if (opts.exchange) return opts.exchange(code);
      return oauth.exchangeCode(code.code, code.codeVerifier, redirectUri);
    },
  };
}

export async function revokeXSession(session: Session, opts: { clientId: string; fetch?: typeof fetch }): Promise<void> {
  if (session.kind !== "oauth") return;
  const oauth = new OAuthClient({ clientId: opts.clientId, fetch: opts.fetch ?? globalThis.fetch.bind(globalThis), crypto: expoPkceCrypto, now: Date.now });
  if (session.refreshToken) await oauth.revoke(session.refreshToken, "refresh_token");
  await oauth.revoke(session.accessToken, "access_token");
}
