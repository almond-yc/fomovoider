import { ConnectorFailure, type Session } from "../types";
import { API_BASE, AUTHORIZE_URL, REVOKE_PATH, SCOPES, TOKEN_PATH } from "./endpoints";

export interface PkceCrypto {
  randomBytes(size: number): Uint8Array;
  sha256Base64(input: string): Promise<string>;
}

export const webCrypto: PkceCrypto = {
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  sha256Base64: async (input) => bytesToBase64(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)))),
};

export interface AuthStart {
  url: string;
  state: string;
  codeVerifier: string;
}

export type OAuthSession = Extract<Session, { kind: "oauth" }>;

export interface OAuthClientOptions {
  clientId: string;
  clientSecret?: string;
  fetch: typeof fetch;
  crypto: PkceCrypto;
  now: () => number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export const toBase64Url = (base64: string) => base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function formEncode(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

export async function createPkcePair(crypto: PkceCrypto): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = toBase64Url(bytesToBase64(crypto.randomBytes(48)));
  const codeChallenge = toBase64Url(await crypto.sha256Base64(codeVerifier));
  return { codeVerifier, codeChallenge };
}

export class OAuthClient {
  constructor(private readonly opts: OAuthClientOptions) {}

  async begin(redirectUri: string): Promise<AuthStart> {
    const { codeVerifier, codeChallenge } = await createPkcePair(this.opts.crypto);
    const state = toBase64Url(bytesToBase64(this.opts.crypto.randomBytes(24)));
    const query = formEncode({
      response_type: "code",
      client_id: this.opts.clientId,
      redirect_uri: redirectUri,
      scope: SCOPES.join(" "),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return { url: `${AUTHORIZE_URL}?${query}`, state, codeVerifier };
  }

  exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<OAuthSession> {
    return this.tokenRequest({ grant_type: "authorization_code", code, code_verifier: codeVerifier, redirect_uri: redirectUri });
  }

  refresh(refreshToken: string): Promise<OAuthSession> {
    return this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async revoke(token: string, tokenTypeHint: "access_token" | "refresh_token"): Promise<void> {
    await this.post(REVOKE_PATH, { token, token_type_hint: tokenTypeHint });
  }

  private async tokenRequest(params: Record<string, string>): Promise<OAuthSession> {
    const res = await this.post(TOKEN_PATH, params);
    if (!res.ok) {
      const detail = safeJson(await res.text());
      if (res.status === 400 || res.status === 401) throw new ConnectorFailure({ kind: "session_expired" }, `X token request failed with HTTP ${res.status}`, { cause: detail });
      throw new ConnectorFailure({ kind: "platform", message: `X token request failed with HTTP ${res.status}` }, undefined, { cause: detail });
    }
    const json = (await res.json()) as TokenResponse;
    const refreshToken = json.refresh_token ?? params.refresh_token;
    return {
      platform: "x",
      kind: "oauth",
      accessToken: json.access_token,
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt: new Date(this.opts.now() + json.expires_in * 1000).toISOString(),
    };
  }

  private async post(path: string, params: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    const body: Record<string, string> = { ...params };
    if (this.opts.clientSecret) {
      headers.authorization = `Basic ${btoa(`${this.opts.clientId}:${this.opts.clientSecret}`)}`;
    } else {
      body.client_id = this.opts.clientId;
    }
    try {
      return await this.opts.fetch(`${API_BASE}${path}`, { method: "POST", headers, body: formEncode(body) });
    } catch (err) {
      throw new ConnectorFailure({ kind: "network" }, "Could not reach the X token endpoint", { cause: err });
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
