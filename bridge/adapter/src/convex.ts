// Pushes bridge events into Convex through its /bridge/events HTTP action.
// Events for one account are delivered in order; message and conversation
// updates are batched for a moment so a backfill becomes a few requests.
import type { Conversation, LoginStep, Message, Person } from "../../../src/connectors/types.js";

// The contract's LoginStep kinds a bridge pairing shows.
export type PairingStep = Extract<LoginStep, { kind: "qr" | "showCode" }>;

export type BridgeEvent =
  | { accountId: string; kind: "pairing"; step: PairingStep }
  | { accountId: string; kind: "connected"; me: Person }
  | { accountId: string; kind: "failed"; error: string }
  | { accountId: string; kind: "logged_out"; reason?: string }
  | { accountId: string; kind: "sync"; conversations: Conversation[]; messages: Message[] };

const MAX_BATCH = 100;

export class ConvexPush {
  private chains = new Map<string, Promise<void>>();
  private pending = new Map<string, { conversations: Map<string, Conversation>; messages: Map<string, Message>; timer: NodeJS.Timeout }>();

  constructor(
    private readonly siteUrl: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options = { flushMs: 300, retries: 5, backoffMs: 500 },
  ) {}

  send(event: BridgeEvent) {
    this.flush(event.accountId);
    return this.enqueue(event.accountId, () => this.post(event));
  }

  sync(accountId: string, update: { conversation?: Conversation; message?: Message }) {
    let batch = this.pending.get(accountId);
    if (!batch) {
      batch = {
        conversations: new Map(),
        messages: new Map(),
        timer: setTimeout(() => this.flush(accountId), this.options.flushMs),
      };
      this.pending.set(accountId, batch);
    }
    if (update.conversation) batch.conversations.set(update.conversation.id, update.conversation);
    if (update.message) batch.messages.set(update.message.id, update.message);
    if (batch.conversations.size + batch.messages.size >= MAX_BATCH) this.flush(accountId);
  }

  // Resolves once everything queued so far has been delivered (or dropped).
  async drain() {
    for (const accountId of [...this.pending.keys()]) this.flush(accountId);
    await Promise.all(this.chains.values());
  }

  private flush(accountId: string) {
    const batch = this.pending.get(accountId);
    if (!batch) return;
    clearTimeout(batch.timer);
    this.pending.delete(accountId);
    const event: BridgeEvent = {
      accountId,
      kind: "sync",
      conversations: [...batch.conversations.values()],
      messages: [...batch.messages.values()],
    };
    void this.enqueue(accountId, () => this.post(event));
  }

  private enqueue(accountId: string, task: () => Promise<void>) {
    const next = (this.chains.get(accountId) ?? Promise.resolve()).then(task).catch((error) => {
      console.error(`convex push for ${accountId} dropped:`, error);
    });
    this.chains.set(accountId, next);
    return next;
  }

  private async post(event: BridgeEvent) {
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      try {
        const response = await this.fetchImpl(`${this.siteUrl}/bridge/events`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json" },
          body: JSON.stringify(event),
        });
        if (response.ok) return;
        status = response.status;
        const detail = await response.text();
        if (status < 500 && status !== 429) throw new Error(`Convex rejected ${event.kind}: ${status} ${detail}`);
        if (attempt >= this.options.retries) throw new Error(`Convex ${status}: ${detail}`);
      } catch (error) {
        if (status && status < 500 && status !== 429) throw error;
        if (attempt >= this.options.retries) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, this.options.backoffMs * 2 ** attempt));
    }
  }
}
