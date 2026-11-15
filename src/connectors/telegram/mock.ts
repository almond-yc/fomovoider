import type { Person, Session } from "../types";
import { TelegramAuth, createTelegramLogin } from "./auth";
import type { TelegramConfig } from "./config";
import { TelegramConnector } from "./connector";
import { type FixtureName, fixtures } from "./fixtures";
import { MemoryPeerStore, MemorySessionStore } from "./sessions";
import { type TelegramClient, TelegramRpcError, type TelegramTransport, type TlObject } from "./transport";

export const MOCK_TELEGRAM_SESSION: Session = { platform: "telegram", kind: "device", deviceId: "mock-device" };
export const MOCK_TELEGRAM_CONFIG: TelegramConfig = { apiId: 1, apiHash: "mock-api-hash" };
// The session string a finished fixture login produces.
export const MOCK_SESSION_STRING = "mock-session";

const fixture = <T = any>(name: FixtureName): T => structuredClone(fixtures[name]) as T;

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const HISTORY: Record<string, FixtureName> = {
  "user:5000000002": "history-bob",
  "channel:1500000001": "history-book-club",
};

function peerKeyOf(peer: TlObject): string {
  if (peer._ === "inputPeerUser") return `user:${peer.userId}`;
  if (peer._ === "inputPeerChannel") return `channel:${peer.channelId}`;
  if (peer._ === "inputPeerChat") return `chat:${peer.chatId}`;
  return peer._;
}

// Answers the calls the connector and the login make from fixtures/. Login:
// a QR code is accepted on the first poll (the next connection); the phone code "12345" signs in,
// "22222" asks for the 2FA password, which is "hunter2". A session string
// that isn't MOCK_SESSION_STRING (or a pending login) is unauthorized.
export function createFixtureTransport(): TelegramTransport {
  return {
    async connect(session) {
      const fresh = !session;
      let current = session || "mock-pending";
      const authorized = () => current === MOCK_SESSION_STRING;
      const client: TelegramClient = {
        async invoke(req: TlObject): Promise<any> {
          const loginCall = req._.startsWith("auth.") || req._ === "account.getPassword";
          if (!loginCall && !authorized()) throw new TelegramRpcError(401, "AUTH_KEY_UNREGISTERED");
          switch (req._) {
            case "users.getUsers":
              return fixture("me");
            case "messages.getDialogs":
              return Number(req.offsetId) ? { _: "messages.dialogs", dialogs: [], messages: [], chats: [], users: [] } : fixture("dialogs");
            case "messages.getPeerDialogs":
              return fixture("peer-dialogs-bob");
            case "messages.getHistory": {
              const name = HISTORY[peerKeyOf(req.peer as TlObject)];
              if (!name) return { _: "messages.messages", messages: [], chats: [], users: [] };
              const res = fixture(name);
              const minId = Number(req.minId ?? 0);
              const offsetId = Number(req.offsetId ?? 0);
              res.messages = (res.messages as TlObject[])
                .filter((m) => (m.id as number) > minId && (!offsetId || (m.id as number) < offsetId))
                .slice(0, Number(req.limit ?? 100));
              return res;
            }
            case "messages.sendMessage": {
              const peer = req.peer as TlObject;
              if (peer._ === "inputPeerChannel") {
                const res = fixture("send-channel");
                res.updates[1].message.message = req.message;
                return res;
              }
              return fixture("send-user");
            }
            case "messages.readHistory":
            case "channels.readHistory":
              return peerKeyOf((req.peer ?? req.channel) as TlObject) && { _: "messages.affectedMessages", pts: 1, ptsCount: 1 };
            case "auth.exportLoginToken": {
              const token = fresh ? fixture("login-token") : fixture("login-token-success");
              if (token._ === "auth.loginToken") return { ...token, token: base64ToBytes(token.token) };
              current = MOCK_SESSION_STRING;
              return token;
            }
            case "auth.sendCode":
              return fixture("sent-code");
            case "auth.signIn":
              if (req.phoneCode === "22222") throw new TelegramRpcError(401, "SESSION_PASSWORD_NEEDED");
              if (req.phoneCode !== "12345") throw new TelegramRpcError(400, "PHONE_CODE_INVALID");
              current = MOCK_SESSION_STRING;
              return fixture("authorization");
            case "account.getPassword":
              return fixture("password");
            case "auth.checkPassword":
              if ((req.password as TlObject).plain !== "hunter2") throw new TelegramRpcError(400, "PASSWORD_HASH_INVALID");
              current = MOCK_SESSION_STRING;
              return fixture("authorization");
            case "auth.logOut":
              return { _: "auth.loggedOut" };
            default:
              throw new TelegramRpcError(400, `NO_FIXTURE_${req._}`);
          }
        },
        async switchDc() {},
        // No SRP in mock mode: the "check" carries the password so
        // auth.checkPassword above can compare it.
        async passwordCheck(_password, plain) {
          return { _: "inputCheckPasswordSRP", plain };
        },
        exportSession: () => current,
        async disconnect() {},
      };
      return client;
    },
  };
}

// The connector over fixtures, with MOCK_TELEGRAM_SESSION already stored and
// a working "steps" login. Needs no credentials.
export function createMockTelegramConnector(): TelegramConnector {
  const transport = createFixtureTransport();
  const sessions = new MemorySessionStore();
  sessions.sessions.set(MOCK_TELEGRAM_SESSION.kind === "device" ? MOCK_TELEGRAM_SESSION.deviceId : "", MOCK_SESSION_STRING);
  let next = 0;
  const save = async (session: string, _me: Person) => {
    const deviceId = `mock-device-${++next}`;
    sessions.sessions.set(deviceId, session);
    return deviceId;
  };
  return new TelegramConnector({
    transport,
    sessions,
    peers: new MemoryPeerStore(),
    login: createTelegramLogin(new TelegramAuth({ transport, config: MOCK_TELEGRAM_CONFIG }), save),
  });
}
