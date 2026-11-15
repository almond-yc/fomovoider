// One mautrix bridgev2 bridge and its provisioning API
// (https://spec.mau.fi/megabridge/).

export interface BridgeConfig {
  platform: string;
  url: string;
  asToken: string;
  provisioningSecret: string;
  // Localpart prefix of the bridge's ghost users (its username_template).
  ghostPrefix: string;
  // m.bridge protocol ids this bridge writes into its portal rooms.
  protocols: string[];
}

export interface LoginStep {
  login_id: string;
  step_id: string;
  type: "display_and_wait" | "user_input" | "cookies" | "complete" | (string & {});
  instructions?: string;
  display_and_wait?: { type: "qr" | "code" | "emoji" | "nothing"; data?: string };
  user_input?: { fields: { type: string; id: string; name: string }[] };
  complete?: { user_login_id: string };
}

export interface WhoamiLogin {
  id: string;
  name?: string;
  profile?: { name?: string; username?: string; phone?: string; email?: string };
}

export class ProvisioningError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ProvisioningError";
  }
}

export class Provisioning {
  constructor(
    readonly bridge: BridgeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, userId: string, body?: unknown): Promise<T> {
    const sep = path.includes("?") ? "&" : "?";
    const response = await this.fetchImpl(
      `${this.bridge.url}/_matrix/provision${path}${sep}user_id=${encodeURIComponent(userId)}`,
      {
        method,
        headers: {
          authorization: `Bearer ${this.bridge.provisioningSecret}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const json = (await response.json().catch(() => ({}))) as { errcode?: string; error?: string };
    if (!response.ok) {
      throw new ProvisioningError(response.status, json.errcode, json.error ?? `HTTP ${response.status}`);
    }
    return json as T;
  }

  start(userId: string, flow: string) {
    return this.call<LoginStep>("POST", `/v3/login/start/${encodeURIComponent(flow)}`, userId);
  }

  // Blocks until the bridge has a new step: a refreshed QR code, or completion.
  wait(userId: string, step: LoginStep) {
    return this.call<LoginStep>(
      "POST",
      `/v3/login/step/${step.login_id}/${encodeURIComponent(step.step_id)}/display_and_wait`,
      userId,
      {},
    );
  }

  submitInput(userId: string, step: LoginStep, fields: Record<string, string>) {
    return this.call<LoginStep>(
      "POST",
      `/v3/login/step/${step.login_id}/${encodeURIComponent(step.step_id)}/user_input`,
      userId,
      fields,
    );
  }

  async logins(userId: string) {
    return (await this.call<{ login_ids: string[] | null }>("GET", "/v3/logins", userId)).login_ids ?? [];
  }

  async whoami(userId: string) {
    return (await this.call<{ logins: WhoamiLogin[] | null }>("GET", "/v3/whoami", userId)).logins ?? [];
  }

  logout(userId: string, loginId: string) {
    return this.call<unknown>("POST", `/v3/logout/${encodeURIComponent(loginId)}`, userId, {});
  }
}
