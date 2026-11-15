import { randomUUID } from "node:crypto";
import type { Id, Message, Person } from "../../../src/connectors/types.js";
import type { BridgeConfig, LoginStep, Provisioning } from "./bridges.js";
import type { ConvexPush, PairingStep } from "./convex.js";
import {
  applyState,
  person,
  roomFromState,
  toConversation,
  toMessage,
  type Owner,
  type Room,
} from "./mapping.js";
import { MatrixError, type Matrix, type MatrixEvent } from "./matrix.js";
import type { StateFile } from "./state.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SEND_STATUS = "com.beeper.message_send_status";
const LOGGED_OUT_STATES = ["BAD_CREDENTIALS", "LOGGED_OUT"];
const RECENT_LIMIT = 5000;
// How long WhatsApp honours what we show, as observed: the first QR for 60 s,
// each refresh for 20 s. A pairing code lasts the whole login window (~160 s).
const FIRST_QR_MS = 60_000;
const NEXT_QR_MS = 20_000;
const CODE_MS = 160_000;

function pairingStep(shown: NonNullable<LoginStep["display_and_wait"]>, first: boolean): PairingStep {
  const expires = (ms: number) => new Date(Date.now() + ms).toISOString();
  if (shown.type === "qr") return { kind: "qr", url: shown.data!, expiresAt: expires(first ? FIRST_QR_MS : NEXT_QR_MS) };
  return { kind: "showCode", code: shown.data!, expiresAt: expires(CODE_MS) };
}
const CATCH_UP_LIMIT = 50;

type SendStatus = { status: string; reason?: string };

export interface AdapterDeps {
  serverName: string;
  bridges: BridgeConfig[];
  matrix: Matrix;
  provisioning: Map<string, Provisioning>;
  convex: ConvexPush;
  state: StateFile;
  sendTimeoutMs?: number;
}

export class Adapter {
  readonly rooms = new Map<string, Room>();
  private readonly notBridged = new Set<string>();
  private readonly recent = new Map<string, Message>();
  private readonly seenTxns = new Set<string>();
  private readonly loginGeneration = new Map<string, number>();
  private readonly sendStatuses = new Map<string, SendStatus>();
  private readonly sendWaiters = new Map<string, (status: SendStatus) => void>();

  constructor(private readonly deps: AdapterDeps) {}

  mxid(accountId: string) {
    return `@fv_${accountId}:${this.deps.serverName}`;
  }

  accountOf(mxid: string) {
    const match = /^@fv_([a-z0-9]+):(.+)$/.exec(mxid);
    if (!match || match[2] !== this.deps.serverName) return undefined;
    return this.deps.state.accounts[match[1]!] ? match[1] : undefined;
  }

  private bridge(platform: string) {
    const bridge = this.deps.bridges.find((b) => b.platform === platform);
    const provisioning = this.deps.provisioning.get(platform);
    if (!bridge || !provisioning) throw new HttpError(400, `No bridge for ${platform}`);
    return { bridge, provisioning };
  }

  private owner(accountId: string): Owner {
    return { mxid: this.mxid(accountId), me: this.deps.state.accounts[accountId]?.me };
  }

  // Starts pairing a Convex account with the platform and returns the first
  // step to show (a QR code, or a code to type into the phone). Later steps
  // and the outcome go to Convex.
  async login(accountId: string, platform: string, method: "qr" | "phone", phone?: string): Promise<PairingStep> {
    if (!/^[a-z0-9]+$/.test(accountId)) throw new HttpError(400, "Invalid accountId");
    const { provisioning } = this.bridge(platform);
    const mxid = this.mxid(accountId);
    await this.deps.matrix.ensureUser(`fv_${accountId}`);
    this.deps.state.accounts[accountId] = { platform };
    this.deps.state.save();
    for (const loginId of await provisioning.logins(mxid)) await provisioning.logout(mxid, loginId);

    let step = await provisioning.start(mxid, method);
    if (step.type === "user_input") {
      const field = step.user_input?.fields[0]?.id;
      if (!phone || !field) throw new HttpError(400, "The phone method needs a phone number");
      step = await provisioning.submitInput(mxid, step, { [field]: phone });
    }
    const shown = step.display_and_wait;
    if (step.type !== "display_and_wait" || !shown?.data) {
      throw new HttpError(502, `Unexpected login step ${step.type}`);
    }
    const generation = (this.loginGeneration.get(accountId) ?? 0) + 1;
    this.loginGeneration.set(accountId, generation);
    void this.waitForLogin(accountId, platform, step, generation);
    return pairingStep(shown, true);
  }

  private async waitForLogin(accountId: string, platform: string, first: LoginStep, generation: number) {
    const { provisioning } = this.bridge(platform);
    const mxid = this.mxid(accountId);
    const current = () => this.loginGeneration.get(accountId) === generation;
    try {
      let step = first;
      for (;;) {
        const next = await provisioning.wait(mxid, step);
        if (!current()) return;
        if (next.type === "complete" && next.complete) {
          const loginId = next.complete.user_login_id;
          const login = (await provisioning.whoami(mxid)).find((l) => l.id === loginId);
          const me: Person = {
            id: `${platform}:${loginId}`,
            platform,
            handle: login?.profile?.username ?? login?.profile?.phone ?? loginId,
            displayName: login?.profile?.name ?? login?.name ?? loginId,
          };
          this.deps.state.accounts[accountId] = { platform, loginId, me };
          this.deps.state.save();
          await this.deps.convex.send({ accountId, kind: "connected", me });
          return;
        }
        const shown = next.display_and_wait;
        if (next.type !== "display_and_wait" || !shown?.data) throw new Error(`Unexpected login step ${next.type}`);
        await this.deps.convex.send({ accountId, kind: "pairing", step: pairingStep(shown, false) });
        step = next;
      }
    } catch (error) {
      if (!current()) return;
      await this.deps.convex.send({ accountId, kind: "failed", error: String((error as Error).message ?? error) });
    }
  }

  async logout(accountId: string) {
    const account = this.deps.state.accounts[accountId];
    if (!account) return;
    this.loginGeneration.set(accountId, (this.loginGeneration.get(accountId) ?? 0) + 1);
    const { provisioning } = this.bridge(account.platform);
    const mxid = this.mxid(accountId);
    for (const loginId of await provisioning.logins(mxid)) await provisioning.logout(mxid, loginId);
    delete this.deps.state.accounts[accountId];
    this.deps.state.save();
    for (const [roomId, room] of this.rooms) if (room.accountId === accountId) this.rooms.delete(roomId);
  }

  // Login state pushed by a bridge (its homeserver.status_endpoint).
  async handleBridgeStatus(platform: string, body: any) {
    const states = [body, body?.bridgeState, ...Object.values(body?.remoteState ?? {})] as any[];
    for (const state of states) {
      if (typeof state?.user_id !== "string" || !LOGGED_OUT_STATES.includes(state.state_event)) continue;
      const accountId = this.accountOf(state.user_id);
      const account = accountId ? this.deps.state.accounts[accountId] : undefined;
      // Only the current login counts: re-pairing logs the old one out.
      if (!accountId || !account || account.platform !== platform) continue;
      if (!account.loginId || state.remote_id !== account.loginId) continue;
      account.loginId = undefined;
      this.deps.state.save();
      await this.deps.convex.send({
        accountId,
        kind: "logged_out",
        reason: state.error ?? state.message ?? state.state_event,
      });
    }
  }

  async handleTransaction(txnId: string, events: MatrixEvent[]) {
    if (this.seenTxns.has(txnId)) return;
    for (const event of events) {
      try {
        await this.handleEvent(event);
      } catch (error) {
        console.error(`event ${event.event_id} in ${event.room_id} failed:`, error);
      }
    }
    this.seenTxns.add(txnId);
    if (this.seenTxns.size > 1000) this.seenTxns.delete(this.seenTxns.values().next().value!);
  }

  private async handleEvent(event: MatrixEvent) {
    const ownAccount = event.type === "m.room.member" && event.state_key ? this.accountOf(event.state_key) : undefined;
    if (ownAccount) {
      const membership = event.content.membership;
      if (membership === "invite") await this.deps.matrix.join(event.room_id, event.state_key!);
      if (membership === "invite" || membership === "join") {
        this.notBridged.delete(event.room_id);
        const room = this.rooms.get(event.room_id) ?? (await this.loadRoom(event.room_id, ownAccount));
        if (room) this.pushConversation(room);
      } else {
        this.rooms.delete(event.room_id);
      }
      return;
    }

    const room = await this.roomFor(event.room_id);
    if (!room) return;
    if (event.state_key !== undefined) {
      if (applyState(room, event)) this.pushConversation(room);
      return;
    }
    if (event.type === SEND_STATUS) {
      const target = event.content["m.relates_to"]?.event_id;
      if (typeof target === "string") this.recordSendStatus(target, event.content);
      return;
    }

    this.ingestMessage(room, event);
  }

  private ingestMessage(room: Room, event: MatrixEvent) {
    const { bridge } = this.bridge(room.platform);
    const owner = this.owner(room.accountId);
    const relation = event.content["m.relates_to"];
    const original =
      relation?.rel_type === "m.replace" ? this.recent.get(`${room.platform}:${relation.event_id}`) : undefined;
    const message = toMessage(event, room, bridge, owner, original);
    if (!message) return;
    this.remember(message);
    if (!room.lastMessage || room.lastMessage.id === message.id || room.lastMessage.sentAt <= message.sentAt) {
      room.lastMessage = message;
      room.lastEventId = event.event_id;
    }
    this.deps.convex.sync(room.accountId, { conversation: toConversation(room, bridge, owner), message });
  }

  private pushConversation(room: Room) {
    const { bridge } = this.bridge(room.platform);
    this.deps.convex.sync(room.accountId, { conversation: toConversation(room, bridge, this.owner(room.accountId)) });
  }

  private remember(message: Message) {
    this.recent.set(message.id, message);
    if (this.recent.size > RECENT_LIMIT) this.recent.delete(this.recent.keys().next().value!);
  }

  // The bridged room behind a Matrix room id. After a restart the cache is
  // empty, so it asks Matrix which served account is in the room.
  private async roomFor(roomId: string) {
    const cached = this.rooms.get(roomId);
    if (cached || this.notBridged.has(roomId)) return cached;
    for (const accountId of Object.keys(this.deps.state.accounts)) {
      try {
        const room = await this.loadRoom(roomId, accountId);
        if (room) return room;
        return undefined;
      } catch (error) {
        if (!(error instanceof MatrixError && error.status === 403)) throw error;
      }
    }
    return undefined;
  }

  private async loadRoom(roomId: string, accountId: string) {
    const mxid = this.mxid(accountId);
    const room = roomFromState(roomId, accountId, await this.deps.matrix.roomState(roomId, mxid), this.deps.bridges);
    if (!room) {
      this.notBridged.add(roomId);
      return undefined;
    }
    this.rooms.set(roomId, room);
    // Catch up on recent messages: ones sent before the adapter's user joined
    // (a race without double puppeting) or while the adapter was down.
    const recent = await this.deps.matrix.lastEvents(roomId, mxid, CATCH_UP_LIMIT);
    for (const event of recent.reverse()) this.ingestMessage(room, event);
    return room;
  }

  private async findRoom(accountId: string, conversationId: string) {
    const match = () =>
      [...this.rooms.values()].find(
        (room) => room.accountId === accountId && `${room.platform}:${room.chatId}` === conversationId,
      );
    if (match()) return match()!;
    const mxid = this.mxid(accountId);
    for (const roomId of await this.deps.matrix.joinedRooms(mxid)) {
      if (!this.rooms.has(roomId) && !this.notBridged.has(roomId)) await this.loadRoom(roomId, accountId);
    }
    const room = match();
    if (!room) throw new HttpError(404, `No conversation ${conversationId}`);
    return room;
  }

  private recordSendStatus(eventId: string, content: Record<string, any>) {
    const status = { status: String(content.status), reason: content.message ?? content.reason };
    if (status.status === "PENDING") return;
    const waiter = this.sendWaiters.get(eventId);
    if (waiter) return waiter(status);
    this.sendStatuses.set(eventId, status);
    if (this.sendStatuses.size > 1000) this.sendStatuses.delete(this.sendStatuses.keys().next().value!);
  }

  private awaitSendStatus(eventId: string) {
    const known = this.sendStatuses.get(eventId);
    if (known) return Promise.resolve(known);
    return new Promise<SendStatus | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.sendWaiters.delete(eventId);
        resolve(undefined);
      }, this.deps.sendTimeoutMs ?? 15_000);
      this.sendWaiters.set(eventId, (status) => {
        clearTimeout(timer);
        this.sendWaiters.delete(eventId);
        resolve(status);
      });
    });
  }

  // Sends a text message and waits for the bridge's delivery status. A send
  // the bridge never confirms within the timeout is returned as sent.
  async send(accountId: string, conversationId: string, text: string): Promise<Message> {
    const account = this.deps.state.accounts[accountId];
    if (!account?.loginId) throw new HttpError(409, "Account is not connected");
    const room = await this.findRoom(accountId, conversationId);
    const mxid = this.mxid(accountId);
    const eventId = await this.deps.matrix.sendMessage(room.roomId, mxid, randomUUID(), { msgtype: "m.text", body: text });
    const status = await this.awaitSendStatus(eventId);
    if (status && status.status !== "SUCCESS") {
      throw new HttpError(502, `${room.platform} refused the message: ${status.reason ?? status.status}`);
    }
    const { bridge } = this.bridge(room.platform);
    const message: Message = {
      id: `${room.platform}:${eventId}`,
      conversationId: conversationId as Id,
      sender: person(mxid, room, bridge, this.owner(accountId)),
      isMine: true,
      sentAt: new Date().toISOString(),
      text,
      media: [],
    };
    this.remember(message);
    return message;
  }

  async markRead(accountId: string, conversationId: string) {
    const room = await this.findRoom(accountId, conversationId);
    const mxid = this.mxid(accountId);
    const eventId = room.lastEventId ?? (await this.deps.matrix.lastEvents(room.roomId, mxid, 1))[0]?.event_id;
    if (eventId) await this.deps.matrix.readReceipt(room.roomId, mxid, eventId);
  }
}
