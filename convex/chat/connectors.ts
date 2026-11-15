import type { Doc } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { Capabilities, ConnectorError, Connector, Person, Session } from "../../src/connectors/types";
import { xConfigFromEnv } from "../../src/connectors/x/config";
import { XConnector } from "../../src/connectors/x/connector";
import { createFixtureFetch } from "../../src/connectors/x/mock";
import { convexUsageStore } from "../x/sync";

type ChatConnector = Pick<Connector, "capabilities" | "send" | "markRead">;

interface ChatPlatform {
  capabilities: Capabilities;
  create(ctx: ActionCtx, account: Doc<"connectedAccounts">, onSessionRefreshed: (session: Session) => void): ChatConnector;
}

// Platforms the inbox can send to and mark read, keyed by platform id. A new
// connector registers here; capabilities must match its connector's own.
export const CHAT_PLATFORMS: Record<string, ChatPlatform> = {
  x: {
    capabilities: { feed: true, chats: true, sendMessage: true, sendMedia: false, reply: true },
    create: (ctx, account, onSessionRefreshed) =>
      new XConnector({
        config: xConfigFromEnv(process.env),
        ...(process.env.X_FIXTURES === "1" ? { fetch: createFixtureFetch() } : {}),
        account: account.me as Person | undefined,
        usage: convexUsageStore(ctx),
        onSessionRefreshed,
      }),
  },
};

// Why a message can't be sent to this conversation right now, or null when it can.
export function sendBlocker(
  conversation: Pick<Doc<"conversations">, "platform" | "unavailable">,
  account: Pick<Doc<"connectedAccounts">, "status"> | null,
): ConnectorError | null {
  if (conversation.unavailable) return { kind: "unsupported", capability: "sendMessage" };
  if (!CHAT_PLATFORMS[conversation.platform]?.capabilities.sendMessage) {
    return { kind: "unsupported", capability: "sendMessage" };
  }
  if (!account || account.status === "expired") return { kind: "session_expired" };
  if (account.status === "pending" || account.status === "resetting") {
    return { kind: "platform", message: "This account is still connecting. Try again in a minute." };
  }
  return null;
}
