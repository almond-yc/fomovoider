import { ConnectorFailure } from "../types";
import { formEncode, type OAuthClient, type OAuthSession } from "./auth";
import { API_BASE } from "./endpoints";

export interface XProblem {
  type?: string;
  title?: string;
  detail?: string;
  status?: number;
}

export interface XErrorCause {
  status: number;
  problem?: XProblem;
}

export interface RateLimitState {
  limit?: number;
  remaining?: number;
  resetAt?: number;
}

export interface XRequest {
  method: "GET" | "POST";
  path: string;
  endpoint: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface CallContext {
  session: OAuthSession;
  refreshed?: boolean;
}

export interface XHttpOptions {
  oauth: OAuthClient;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  onRefreshed: (session: OAuthSession) => void;
}

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const REFRESH_MEMO_MS = 5 * 60 * 1000;
const PROBLEM_PREFIX = /^https:\/\/api\.(x|twitter)\.com\/2\/problems\//;

export function problemSlug(problem: XProblem | undefined): string | undefined {
  return problem?.type?.replace(PROBLEM_PREFIX, "");
}

export function isOutOfCredits(status: number, problem: XProblem | undefined): boolean {
  if (status === 402) return true;
  const slug = problemSlug(problem) ?? "";
  if (slug === "usage-capped" || /credit/.test(slug)) return true;
  return /credit|balance|spend(ing)? limit|usage cap/i.test(`${problem?.title ?? ""} ${problem?.detail ?? ""}`);
}

export function xCause(err: unknown): XErrorCause | undefined {
  const cause = err instanceof ConnectorFailure ? (err.cause as XErrorCause | undefined) : undefined;
  return cause && typeof cause.status === "number" ? cause : undefined;
}

export class XHttp {
  private readonly refreshes = new Map<string, { promise: Promise<OAuthSession>; at: number }>();
  private readonly limits = new Map<string, RateLimitState>();

  constructor(private readonly opts: XHttpOptions) {}

  rateLimit(endpoint: string): RateLimitState | undefined {
    return this.limits.get(endpoint);
  }

  async request<T>(ctx: CallContext, req: XRequest): Promise<T> {
    const bucket = this.limits.get(req.endpoint);
    if (bucket?.remaining === 0 && bucket.resetAt !== undefined && bucket.resetAt > this.opts.now()) {
      throw new ConnectorFailure({ kind: "rate_limited", retryAt: new Date(bucket.resetAt).toISOString() });
    }

    await this.ensureFresh(ctx);
    let res = await this.send(req, ctx.session.accessToken);
    if (res.status === 401 && !ctx.refreshed && ctx.session.refreshToken) {
      await this.refresh(ctx);
      res = await this.send(req, ctx.session.accessToken);
    }
    if (res.status >= 500 && req.method === "GET") {
      await this.opts.sleep(500 + Math.floor(Math.random() * 1000));
      res = await this.send(req, ctx.session.accessToken);
    }

    const rateLimit = readRateLimit(res.headers);
    if (rateLimit.remaining !== undefined || rateLimit.resetAt !== undefined) this.limits.set(req.endpoint, rateLimit);

    const text = await res.text();
    const body = text ? safeJson(text) : undefined;
    if (!res.ok) throw toFailure(res.status, body as XProblem | undefined, rateLimit, req);
    return body as T;
  }

  private async ensureFresh(ctx: CallContext): Promise<void> {
    const { expiresAt, refreshToken } = ctx.session;
    if (!expiresAt || Date.parse(expiresAt) - this.opts.now() >= REFRESH_SKEW_MS) return;
    if (refreshToken) return this.refresh(ctx);
    if (Date.parse(expiresAt) <= this.opts.now()) throw new ConnectorFailure({ kind: "session_expired" }, "X access token expired and there is no refresh token");
  }

  private async refresh(ctx: CallContext): Promise<void> {
    const refreshToken = ctx.session.refreshToken!;
    const now = this.opts.now();
    for (const [key, entry] of this.refreshes) if (now - entry.at > REFRESH_MEMO_MS) this.refreshes.delete(key);
    let entry = this.refreshes.get(refreshToken);
    if (!entry) {
      const promise = this.opts.oauth.refresh(refreshToken).then((next) => {
        this.opts.onRefreshed(next);
        return next;
      });
      entry = { promise, at: now };
      this.refreshes.set(refreshToken, entry);
      promise.catch(() => this.refreshes.delete(refreshToken));
    }
    ctx.session = await entry.promise;
    ctx.refreshed = true;
  }

  private async send(req: XRequest, accessToken: string): Promise<Response> {
    const query = formEncode(req.query ?? {});
    const url = query ? `${API_BASE}${req.path}?${query}` : `${API_BASE}${req.path}`;
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
    if (req.body !== undefined) headers["content-type"] = "application/json";
    try {
      return await this.opts.fetch(url, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      });
    } catch (err) {
      throw new ConnectorFailure({ kind: "network" }, `Could not reach X (${req.endpoint})`, { cause: err });
    }
  }
}

function readRateLimit(headers: Headers): RateLimitState {
  const num = (name: string) => {
    const v = headers.get(name);
    return v === null || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v);
  };
  const reset = num("x-rate-limit-reset");
  return { limit: num("x-rate-limit-limit"), remaining: num("x-rate-limit-remaining"), resetAt: reset === undefined ? undefined : reset * 1000 };
}

function toFailure(status: number, problem: XProblem | undefined, rateLimit: RateLimitState, req: XRequest): ConnectorFailure {
  const cause: XErrorCause = { status, problem };
  const detail = problem?.detail ?? problem?.title ?? `HTTP ${status}`;
  if (isOutOfCredits(status, problem)) {
    return new ConnectorFailure({ kind: "budget_exhausted" }, `X API credits are used up or the spending limit was reached: ${detail}`, { cause });
  }
  if (status === 429) {
    const retryAt = rateLimit.resetAt === undefined ? undefined : new Date(rateLimit.resetAt).toISOString();
    return new ConnectorFailure({ kind: "rate_limited", ...(retryAt ? { retryAt } : {}) }, `X rate limit hit on ${req.endpoint}`, { cause });
  }
  if (status === 401) return new ConnectorFailure({ kind: "session_expired" }, "X rejected the access token; log in again", { cause });
  return new ConnectorFailure({ kind: "platform", message: `X: ${detail}` }, undefined, { cause });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}
