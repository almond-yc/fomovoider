"use node";

import { ConvexError, type Infer, v } from "convex/values";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, action } from "../_generated/server";
import { requireUserId } from "../lib/auth";
import { ConnectorFailure } from "../../src/connectors/types";
import type { AuthResult, PendingLogin } from "../../src/connectors/telegram/auth";
import { decryptSecret, encryptSecret } from "./secret";
import { telegramAuth, toConnectorError } from "./runtime";

// The Telegram connect flow, one action per round of the contract's "steps"
// Login: the app calls start, shows the step, and calls next with the
// person's answer (none to poll a QR code) until it gets "done". The
// half-finished login is kept encrypted in telegram_logins between rounds.
// Failures throw a ConvexError whose data is a ConnectorError; a wrong code
// or password keeps the step, so the app can ask again.
const LOGIN_TTL_MS = 10 * 60 * 1000;

const vStep = v.union(
  v.object({ kind: v.literal("qr"), url: v.string(), expiresAt: v.string() }),
  v.object({ kind: v.literal("code"), phone: v.string(), via: v.optional(v.string()), length: v.optional(v.number()) }),
  v.object({ kind: v.literal("password"), hint: v.optional(v.string()) }),
  v.object({ kind: v.literal("done"), session: v.object({ platform: v.literal("telegram"), kind: v.literal("device"), deviceId: v.string() }) }),
);

export const start = action({
  args: { method: v.union(v.literal("qr"), v.literal("phone")), phone: v.optional(v.string()) },
  returns: vStep,
  handler: async (ctx, { method, phone }) => {
    const userId = await requireUserId(ctx);
    if (method === "phone" && !phone) throw new ConvexError({ kind: "platform", message: "Enter your phone number." });
    const auth = await telegramAuth();
    return settle(ctx, userId, () => auth.start(method === "qr" ? { method } : { method, phone: phone! }));
  },
});

export const next = action({
  args: { answer: v.optional(v.string()) },
  returns: vStep,
  handler: async (ctx, { answer }) => {
    const userId = await requireUserId(ctx);
    const login = await ctx.runQuery(internal.telegram.state.getLogin, { userId });
    if (!login || login.expiresAt < Date.now()) throw new ConvexError({ kind: "platform", message: "This Telegram login expired. Start again." });
    const pending = JSON.parse(await decryptSecret(login.secret)) as PendingLogin;
    const auth = await telegramAuth();
    return settle(ctx, userId, () => auth.next(pending, answer));
  },
});

export const cancel = action({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    await ctx.runMutation(internal.telegram.state.deleteLogin, { userId });
    return null;
  },
});

async function settle(ctx: ActionCtx, userId: Id<"users">, round: () => Promise<AuthResult>): Promise<Infer<typeof vStep>> {
  let result: AuthResult;
  try {
    result = await round();
  } catch (err) {
    const error = toConnectorError(err);
    // A login that can't go on (expired code or QR token, revoked) starts over.
    if (err instanceof ConnectorFailure && /expired|no longer valid|Start again/.test(error.kind === "platform" ? error.message : "")) {
      await ctx.runMutation(internal.telegram.state.deleteLogin, { userId });
    }
    throw new ConvexError(error);
  }
  if (!result.done) {
    await ctx.runMutation(internal.telegram.state.saveLogin, {
      userId,
      secret: await encryptSecret(JSON.stringify(result.pending)),
      expiresAt: Date.now() + LOGIN_TTL_MS,
    });
    return result.step;
  }
  const deviceId = await ctx.runMutation(internal.telegram.state.createSession, {
    userId,
    secret: await encryptSecret(result.session),
    telegramUserId: result.me.id,
  });
  const session = { platform: "telegram" as const, kind: "device" as const, deviceId };
  const accountId = await ctx.runMutation(api.accounts.connect, { session });
  await ctx.runMutation(internal.telegram.state.deleteLogin, { userId });
  await ctx.scheduler.runAfter(0, internal.telegram.sync.syncAccount, { accountId });
  return { kind: "done", session };
}
