// Live smoke test for the Telegram connector (manual). Logs in with a phone
// code (and 2FA password) or a QR code, prints the account and the newest 5
// chats normalized, then logs the session out again. The session string stays
// in memory. Refuses to run without TELEGRAM_LIVE=1. Use a throwaway account.
//
//   TELEGRAM_LIVE=1 TELEGRAM_API_ID=... TELEGRAM_API_HASH=... npm run telegram:smoke
//   TELEGRAM_LOGIN=qr ... npm run telegram:smoke     # QR instead of phone code
import { createInterface } from "node:readline/promises";
import { TelegramAuth, createTelegramLogin } from "../src/connectors/telegram/auth";
import { telegramConfigFromEnv } from "../src/connectors/telegram/config";
import { TelegramConnector } from "../src/connectors/telegram/connector";
import { createGramJsTransport } from "../src/connectors/telegram/gramjs";
import { MemorySessionStore } from "../src/connectors/telegram/sessions";
import type { LoginStep } from "../src/connectors/types";

if (process.env.TELEGRAM_LIVE !== "1") {
  console.error("Refusing to run without TELEGRAM_LIVE=1 (this logs in to a real Telegram account).");
  process.exit(1);
}

const config = telegramConfigFromEnv(process.env);
const transport = createGramJsTransport(config);
const auth = new TelegramAuth({ transport, config });
const sessions = new MemorySessionStore();
const login = createTelegramLogin(auth, async (session) => {
  sessions.sessions.set("smoke", session);
  return "smoke";
});
if (login.kind !== "steps") throw new Error("unreachable");
const rl = createInterface({ input: process.stdin, output: process.stdout });

let step: LoginStep =
  process.env.TELEGRAM_LOGIN === "qr" ? await login.start({ method: "qr" }) : await login.start({ method: "phone", phone: await rl.question("Phone (international format): ") });
while (step.kind !== "done") {
  if (step.kind === "qr") {
    console.log(`Open this as a QR code and scan it in Telegram → Settings → Devices → Link Desktop Device (expires ${step.expiresAt}):\n${step.url}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    step = await login.next();
  } else if (step.kind === "code") {
    step = await login.next(await rl.question(`Code sent via ${step.via ?? "Telegram"}: `));
  } else {
    step = await login.next(await rl.question(`2FA password${step.hint ? ` (hint: ${step.hint})` : ""}: `));
  }
}
rl.close();

const tg = new TelegramConnector({ transport, sessions });
try {
  console.log(JSON.stringify((await tg.account(step.session)).me, null, 2));
  const chats = await tg.conversations(step.session, { limit: 5 });
  for (const c of chats.items) {
    const { raw: _raw, ...last } = c.lastMessage ?? ({} as Record<string, unknown>);
    console.log(JSON.stringify({ ...c, lastMessage: c.lastMessage ? last : undefined }, null, 2));
  }
} finally {
  await tg.close();
  await auth.logOut(sessions.sessions.get("smoke")!);
  console.log("Logged the smoke session out.");
}
