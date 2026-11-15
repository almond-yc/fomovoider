// The adapter's appservice client. It acts as its @fv_<accountId> users by
// masquerading (?user_id=), so it needs no per-user access tokens.

export interface MatrixEvent {
  event_id: string;
  room_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  state_key?: string;
  content: Record<string, any>;
  unsigned?: Record<string, any>;
}

export class MatrixError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "MatrixError";
  }
}

export class Matrix {
  constructor(
    private readonly homeserverUrl: string,
    private readonly asToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, asUser?: string, body?: unknown): Promise<T> {
    const url = new URL(`${this.homeserverUrl}/_matrix/client/v3${path}`);
    if (asUser) url.searchParams.set("user_id", asUser);
    const response = await this.fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${this.asToken}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json().catch(() => ({}))) as { errcode?: string; error?: string };
    if (!response.ok) {
      throw new MatrixError(response.status, json.errcode, json.error ?? `HTTP ${response.status}`);
    }
    return json as T;
  }

  async ensureUser(localpart: string) {
    try {
      await this.call("POST", "/register", undefined, {
        type: "m.login.application_service",
        username: localpart,
        inhibit_login: true,
      });
    } catch (error) {
      if (!(error instanceof MatrixError && error.errcode === "M_USER_IN_USE")) throw error;
    }
  }

  join(roomId: string, asUser: string) {
    return this.call("POST", `/join/${encodeURIComponent(roomId)}`, asUser, {});
  }

  async joinedRooms(asUser: string) {
    return (await this.call<{ joined_rooms: string[] }>("GET", "/joined_rooms", asUser)).joined_rooms;
  }

  roomState(roomId: string, asUser: string) {
    return this.call<MatrixEvent[]>("GET", `/rooms/${encodeURIComponent(roomId)}/state`, asUser);
  }

  event(roomId: string, asUser: string, eventId: string) {
    return this.call<MatrixEvent>(
      "GET",
      `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
      asUser,
    );
  }

  async lastEvents(roomId: string, asUser: string, limit: number) {
    const query = `dir=b&limit=${limit}`;
    return (
      await this.call<{ chunk: MatrixEvent[] }>(
        "GET",
        `/rooms/${encodeURIComponent(roomId)}/messages?${query}`,
        asUser,
      )
    ).chunk;
  }

  async sendMessage(roomId: string, asUser: string, txnId: string, content: Record<string, unknown>) {
    const path = `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`;
    return (await this.call<{ event_id: string }>("PUT", path, asUser, content)).event_id;
  }

  readReceipt(roomId: string, asUser: string, eventId: string) {
    const path = `/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`;
    return this.call("POST", path, asUser, {});
  }
}
