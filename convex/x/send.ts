import { ConvexError, type Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { type ActionCtx, action, internalAction } from "../_generated/server";
import { requireUserId } from "../lib/auth";
import { vMessage } from "../lib/validators";
import { ConnectorFailure, type ConnectorError, type Id, type Message, type Person, type Post, type Session } from "../../src/connectors/types";
import { xConfigFromEnv } from "../../src/connectors/x/config";
import { XConnector } from "../../src/connectors/x/connector";
import { createFixtureFetch } from "../../src/connectors/x/mock";
import { convexUsageStore } from "./sync";

// Sending happens only when the app calls these, i.e. when a person taps
// send; the sync never posts on anyone's behalf. Each send uses one of the
// daily writes (X_DAILY_WRITE_BUDGET) and is stored right away, so the inbox
// and feed show it before the next sync. Failures throw a ConvexError
// carrying a ConnectorError.

// A legacy DM. Internal: the app's one send path, messages.send, checks the
// user owns the account and conversation and calls this for X.
export const message = internalAction({
  args: { accountId: v.id("connectedAccounts"), conversationId: v.string(), text: v.string() },
  returns: vMessage,
  handler: async (ctx, { accountId, conversationId, text }): Promise<Infer<typeof vMessage>> => {
    if ((await ctx.runQuery(internal.x.chatKeys.keysActive, { accountId })) && (await ctx.runQuery(internal.x.chat.isXChat, { accountId, conversationId }))) {
      return await ctx.runAction(internal.x.chatNode.send, { accountId, conversationId, text });
    }
    const account = await ctx.runQuery(internal.accounts.get, { accountId });
    const sent: Message = await withX(ctx, account, (x, session) => x.send(session, conversationId as Id, { text }));
    const { raw: _raw, ...stored } = sent;
    await ctx.runMutation(internal.ingest.upsertMessages, { accountId, messages: [stored] });
    const message = { ...stored, sentAt: Date.parse(stored.sentAt) };
    await ctx.runMutation(internal.x.state.showMessage, { accountId, message });
    return message;
  },
});

// A reply to one of the caller's synced posts. X only allows replies to posts
// that @mention the user or quote one of their posts; anything else fails
// with a platform error explaining that.
export const reply = action({
  args: { postId: v.string(), text: v.string() },
  returns: v.object({ id: v.string(), createdAt: v.number(), permalink: v.string() }),
  handler: async (ctx, { postId, text }): Promise<{ id: string; createdAt: number; permalink: string }> => {
    const userId = await requireUserId(ctx);
    const { account, post } = await ctx.runQuery(internal.x.state.sendTarget, { userId, postId });
    if (!post || post.platform !== "x") throw new ConvexError<ConnectorError>({ kind: "platform", message: "Post not found" });
    const sent: Post = await withX(ctx, account, (x, session) => x.reply!(session, postId as Id, { text }));
    await ctx.runMutation(internal.ingest.upsertPosts, { accountId: account!._id, posts: [sent] });
    return { id: sent.id, createdAt: Date.parse(sent.createdAt), permalink: sent.permalink };
  },
});

export async function withX<T>(
  ctx: ActionCtx,
  account: Doc<"connectedAccounts"> | null,
  send: (x: XConnector, session: Session) => Promise<T>,
): Promise<T> {
  if (!account || account.platform !== "x" || account.session.kind !== "oauth") {
    throw new ConvexError<ConnectorError>({ kind: "platform", message: "X is not connected" });
  }
  if (account.status === "expired") throw new ConvexError<ConnectorError>({ kind: "session_expired" });
  if (account.status !== "active" && account.status !== "error") {
    throw new ConvexError<ConnectorError>({ kind: "platform", message: "X is still being set up; try again in a minute" });
  }
  const accountId = account._id;
  let sessionVersion = account.sessionVersion ?? 0;
  let saving: Promise<unknown> = Promise.resolve();
  try {
    const x = new XConnector({
      config: xConfigFromEnv(process.env),
      ...(process.env.X_FIXTURES === "1" ? { fetch: createFixtureFetch() } : {}),
      account: account.me as Person | undefined,
      usage: convexUsageStore(ctx),
      // A refresh that loses to a reconnect or a concurrent sync is dropped;
      // the newer session stays.
      onSessionRefreshed: (next) => {
        saving = saving.then(async () => {
          const result = await ctx.runMutation(internal.accounts.saveSession, {
            accountId,
            session: next as Doc<"connectedAccounts">["session"],
            expectedVersion: sessionVersion,
          });
          if (result.saved) sessionVersion = result.sessionVersion;
        });
      },
    });
    const result = await send(x, account.session as Session);
    await saving;
    return result;
  } catch (err) {
    await saving.catch(() => undefined);
    if (err instanceof ConnectorFailure) throw new ConvexError(err.error);
    throw err;
  }
}
