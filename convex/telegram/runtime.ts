"use node";

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ConnectorFailure, type ConnectorError } from "../../src/connectors/types";
import { TelegramAuth } from "../../src/connectors/telegram/auth";
import { type TelegramConfig, telegramConfigFromEnv } from "../../src/connectors/telegram/config";
import { TelegramConnector } from "../../src/connectors/telegram/connector";
import { MOCK_TELEGRAM_CONFIG, createFixtureTransport } from "../../src/connectors/telegram/mock";
import type { PeerStore } from "../../src/connectors/telegram/sessions";
import type { TelegramTransport } from "../../src/connectors/telegram/transport";
import { decryptSecret } from "./secret";

// TELEGRAM_FIXTURES=1 answers every Telegram call from the connector's
// fixtures (local backends only). Otherwise GramJS, loaded on demand so
// nothing else pulls it in.
function config(): TelegramConfig {
  return process.env.TELEGRAM_FIXTURES === "1" ? MOCK_TELEGRAM_CONFIG : telegramConfigFromEnv(process.env);
}

async function transport(): Promise<TelegramTransport> {
  if (process.env.TELEGRAM_FIXTURES === "1") return createFixtureTransport();
  const { createGramJsTransport } = await import("../../src/connectors/telegram/gramjs");
  return createGramJsTransport(config());
}

export async function telegramAuth(): Promise<TelegramAuth> {
  return new TelegramAuth({ transport: await transport(), config: config() });
}

// A connector for one stored session. The deviceId the connector sees is
// the telegram_sessions id.
export async function telegramConnector(ctx: ActionCtx, session: { _id: Id<"telegram_sessions">; secret: string }): Promise<TelegramConnector> {
  const peers: PeerStore = {
    get: (_deviceId, keys) => ctx.runQuery(internal.telegram.state.getPeers, { sessionId: session._id, keys }),
    put: async (_deviceId, hashes) => {
      await ctx.runMutation(internal.telegram.state.putPeers, { sessionId: session._id, hashes });
    },
  };
  return new TelegramConnector({
    transport: await transport(),
    sessions: { load: async (deviceId) => (deviceId === session._id ? await decryptSecret(session.secret) : null) },
    peers,
  });
}

export function toConnectorError(err: unknown): ConnectorError {
  if (err instanceof ConnectorFailure) return err.error;
  return { kind: "platform", message: err instanceof Error ? err.message : String(err) };
}
