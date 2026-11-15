import { ConnectorFailure } from "../types";

// From my.telegram.org → API development tools. Server-side only: the hash
// identifies our app to Telegram and never ships in the client.
export interface TelegramConfig {
  apiId: number;
  apiHash: string;
}

export function telegramConfigFromEnv(env: Record<string, string | undefined>): TelegramConfig {
  const apiId = Number(env.TELEGRAM_API_ID);
  const apiHash = env.TELEGRAM_API_HASH;
  if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
    throw new ConnectorFailure({ kind: "platform", message: "TELEGRAM_API_ID and TELEGRAM_API_HASH must be set (my.telegram.org)" });
  }
  return { apiId, apiHash };
}
