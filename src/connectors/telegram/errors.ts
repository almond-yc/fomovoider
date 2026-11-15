import { ConnectorFailure } from "../types";
import { TelegramRpcError } from "./transport";

// Errors that mean the session no longer works: logged out from another
// device, terminated in Settings → Devices, or the account is gone.
const SESSION_ERRORS = new Set([
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_INVALID",
  "AUTH_KEY_PERM_EMPTY",
  "AUTH_KEY_DUPLICATED",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
]);

const FRIENDLY: Record<string, string> = {
  PHONE_NUMBER_INVALID: "That phone number isn't valid. Use the international format, e.g. +34600000000.",
  PHONE_NUMBER_BANNED: "Telegram has banned this phone number.",
  PHONE_CODE_INVALID: "That code is wrong. Check the latest code Telegram sent.",
  PHONE_CODE_EMPTY: "Enter the code Telegram sent.",
  PHONE_CODE_EXPIRED: "That code has expired. Start again to get a new one.",
  PASSWORD_HASH_INVALID: "That password is wrong.",
  AUTH_TOKEN_EXPIRED: "The QR code expired. Start again.",
  AUTH_TOKEN_INVALID: "The QR code is no longer valid. Start again.",
  CHAT_WRITE_FORBIDDEN: "You can't send messages in this chat.",
  CHAT_RESTRICTED: "You can't send messages in this chat.",
  USER_IS_BLOCKED: "This person has blocked you.",
  YOU_BLOCKED_USER: "You blocked this person. Unblock them in Telegram first.",
  PEER_ID_INVALID: "Telegram doesn't know this chat.",
  CHANNEL_PRIVATE: "This chat is private or you left it.",
  MESSAGE_TOO_LONG: "The message is too long for Telegram (4096 characters).",
};

const WAIT = /^(?:FLOOD_WAIT|FLOOD_PREMIUM_WAIT|SLOWMODE_WAIT)_(\d+)$/;

export function toConnectorFailure(err: unknown, now: () => number): ConnectorFailure {
  if (err instanceof ConnectorFailure) return err;
  if (!(err instanceof TelegramRpcError)) return new ConnectorFailure({ kind: "network" }, "Could not reach Telegram", { cause: err });
  const wait = WAIT.exec(err.errorMessage);
  if (wait) {
    return new ConnectorFailure({ kind: "rate_limited", retryAt: new Date(now() + Number(wait[1]) * 1000).toISOString() }, err.errorMessage, { cause: err });
  }
  if (err.code === 401 || SESSION_ERRORS.has(err.errorMessage)) return new ConnectorFailure({ kind: "session_expired" }, err.errorMessage, { cause: err });
  if (err.code === 420) return new ConnectorFailure({ kind: "rate_limited" }, err.errorMessage, { cause: err });
  if (err.code >= 500 || err.code === -503) return new ConnectorFailure({ kind: "network" }, err.errorMessage, { cause: err });
  const message = FRIENDLY[err.errorMessage] ?? `Telegram refused the request: ${err.errorMessage}`;
  return new ConnectorFailure({ kind: "platform", message }, undefined, { cause: err });
}

export function rpcErrorMessage(err: unknown): string | undefined {
  return err instanceof TelegramRpcError ? err.errorMessage : undefined;
}
