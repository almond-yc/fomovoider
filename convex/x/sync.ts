import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { type ActionCtx, internalAction, internalMutation, mutation } from "../_generated/server";
import { requireUserId } from "../lib/auth";
import { recordSyncRequest } from "./state";
import { ConnectorFailure, type ConnectorError, type Person, type Session } from "../../src/connectors/types";
import type { UsageStore } from "../../src/connectors/x/budget";
import { xConfigFromEnv } from "../../src/connectors/x/config";
import { XConnector } from "../../src/connectors/x/connector";
import { createFixtureFetch } from "../../src/connectors/x/mock";

// Per-run limits. With the cron every 6 hours these fit the connector's
// default daily budget (config.ts): 10 posts cost 20 of the 60 daily post
// reads, so three runs a day read the feed in full, and DMs take 4 x 2 of the
// 10 daily DM event reads. Whatever the budget can't cover waits for the next
// UTC day.
export const FEED_LIMIT = 10;
export const DM_LIMIT = 2;
const FIRST_FEED_WINDOW_MS = 24 * 60 * 60 * 1000;
const RETRY_PENDING_MS = 60 * 1000;
const REQUEST_SYNC_MIN_INTERVAL_MS = 15 * 60 * 1000;

// Cron entry point: one scheduled sync per connected X account, so one
// account's failure never blocks another.
export const syncAll = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const accounts = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_platform", (q) => q.eq("platform", "x"))
      .collect();
    for (const account of accounts) {
      if (account.status === "expired" || account.status === "resetting") continue;
      await ctx.scheduler.runAfter(0, internal.x.sync.syncAccount, { accountId: account._id });
    }
    return null;
  },
});

// For the app: sync now (after connecting X, or on pull to refresh). Returns
// false when the last sync is too recent; the daily budget still applies.
export const requestSync = mutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const account = await ctx.db
      .query("connectedAccounts")
      .withIndex("by_userId_and_platform", (q) => q.eq("userId", userId).eq("platform", "x"))
      .unique();
    if (!account || account.status === "expired" || account.status === "resetting") return false;
    if (!(await recordSyncRequest(ctx, account._id, REQUEST_SYNC_MIN_INTERVAL_MS))) return false;
    await ctx.scheduler.runAfter(0, internal.x.sync.syncAccount, { accountId: account._id });
    return true;
  },
});

// feedLimit and dmLimit override FEED_LIMIT and DM_LIMIT for a one-off run
// (npx convex run); the daily budget still caps them.
export const syncAccount = internalAction({
  args: { accountId: v.id("connectedAccounts"), feedLimit: v.optional(v.number()), dmLimit: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { accountId, feedLimit, dmLimit }) => {
    const loaded = await ctx.runQuery(internal.x.state.load, { accountId });
    if (!loaded || loaded.account.platform !== "x" || loaded.account.session.kind !== "oauth") return null;
    const { account } = loaded;
    if (account.status === "expired" || account.status === "resetting") return null;
    if (!(await ctx.runMutation(internal.x.state.claimSync, { accountId }))) {
      // A sync of the previous session still holds the lease; a reconnected
      // account must not wait for the next cron to be verified.
      if (account.status === "pending") await ctx.scheduler.runAfter(RETRY_PENDING_MS, internal.x.sync.syncAccount, { accountId });
      return null;
    }

    let session = account.session as Session;
    let saving: Promise<unknown> = Promise.resolve();
    let stale = false;
    let sessionVersion = account.sessionVersion ?? 0;
    const connect = (me?: Person) =>
      new XConnector({
        config: xConfigFromEnv(process.env),
        ...(process.env.X_FIXTURES === "1" ? { fetch: createFixtureFetch() } : {}),
        account: me,
        usage: convexUsageStore(ctx),
        onSessionRefreshed: (next) => {
          session = next;
          saving = saving.then(async () => {
            const result = await ctx.runMutation(internal.accounts.saveSession, {
              accountId,
              session: next as Doc<"connectedAccounts">["session"],
              expectedVersion: sessionVersion,
            });
            if (!result.saved) {
              stale = true;
              throw new StaleSync();
            }
            sessionVersion = result.sessionVersion;
          });
        },
      });

    try {
      let me = account.me as Person | undefined;
      if (account.status === "pending" || !me) {
        me = (await connect().account(session)).me;
        await saving;
        await ctx.runMutation(internal.accounts.verifyIdentity, { accountId, me });
        if (account.me && account.me.id !== me.id) return null;
      }
      await syncWith(ctx, connect(me), () => session, {
        account: { ...account, me },
        me,
        feedCursor: loaded.feedCursor,
        state: loaded.state?.xUserId === me.id ? loaded.state : null,
        feedLimit: feedLimit ?? FEED_LIMIT,
        dmLimit: dmLimit ?? DM_LIMIT,
      });
      await saving;
      await ctx.runMutation(internal.accounts.recordSync, { accountId });
    } catch (err) {
      await saving.catch(() => undefined);
      const current = await ctx.runQuery(internal.accounts.get, { accountId });
      const reconnected = (current?.sessionVersion ?? 0) !== sessionVersion;
      if (!stale && !reconnected && !(err instanceof StaleSync)) {
        await ctx.runMutation(internal.accounts.recordSync, { accountId, error: toConnectorError(err) });
      }
    } finally {
      await ctx.runMutation(internal.x.state.releaseSync, { accountId });
    }
    return null;
  },
});

interface SyncInput {
  account: Doc<"connectedAccounts">;
  me: Person;
  feedCursor?: string;
  state: Doc<"x_sync_state"> | null;
  feedLimit: number;
  dmLimit: number;
}

// Extract only: posts and DMs are stored as X returns them, normalized and
// unscored. Filtering is the app's job.
async function syncWith(ctx: ActionCtx, x: XConnector, session: () => Session, input: SyncInput) {
  const { account, me } = input;
  const accountId = account._id;
  const saveState = (patch: Partial<Omit<Doc<"x_sync_state">, "_id" | "_creationTime" | "accountId" | "xUserId">>, endDmPass?: boolean) =>
    ctx.runMutation(internal.x.state.saveState, { accountId, xUserId: me.id, patch, endDmPass });

  // Every legacy DM. Each run walks newest to older from the saved cursor
  // until it reaches the last pass's newest event, so history accumulates in
  // Convex past X's 30-day window.
  await withinBudget(async () => {
    const inbox = await x.inbox(session(), { sinceId: input.state?.dmSinceId, cursor: input.state?.dmCursor, limit: input.dmLimit });
    const newer = new Set(
      await ctx.runQuery(internal.x.state.newerConversations, {
        userId: account.userId,
        conversations: inbox.conversations.map(({ id, updatedAt }) => ({ id, updatedAt })),
      }),
    );
    const conversations = inbox.conversations.filter((c) => newer.has(c.id));
    if (conversations.length) await ctx.runMutation(internal.ingest.upsertConversations, { accountId, conversations });
    if (inbox.messages.length) await ctx.runMutation(internal.ingest.upsertMessages, { accountId, messages: inbox.messages });
    const passNewest = input.state?.dmPassNewestId ?? inbox.newestId;
    if (inbox.cursor) await saveState({ dmCursor: inbox.cursor, dmPassNewestId: passNewest });
    else await saveState({ dmSinceId: passNewest ?? input.state?.dmSinceId }, true);
  });

  // Mentions plus the home timeline, without replies or reposts.
  await withinBudget(async () => {
    const since = input.feedCursor ?? new Date(Date.now() - FIRST_FEED_WINDOW_MS).toISOString();
    const page = await x.feed(session(), { since, limit: input.feedLimit });
    await ctx.runMutation(internal.ingest.upsertPosts, { accountId, posts: page.items, page: { cursor: page.cursor, caughtUp: page.caughtUp } });
  });
}

// The user reconnected while this sync ran: its session and work are stale,
// so it stops without saving or recording anything.
class StaleSync extends Error {}

// Fomovoider's own daily budget running out ends that step quietly: it is
// expected, resets at UTC midnight (resetsAt), and is not an account error.
// X refusing for lack of credits (402, no resetsAt) is recorded on the account.
async function withinBudget(step: () => Promise<void>) {
  try {
    await step();
  } catch (err) {
    if (err instanceof ConnectorFailure && err.error.kind === "budget_exhausted" && err.error.resetsAt) return;
    throw err;
  }
}

function toConnectorError(err: unknown): ConnectorError {
  if (err instanceof ConnectorFailure) return err.error;
  return { kind: "platform", message: err instanceof Error ? err.message : String(err) };
}

function convexUsageStore(ctx: ActionCtx): UsageStore {
  return {
    used: (key) => ctx.runQuery(internal.x.state.usageUsed, { key }),
    reserve: (key, amount, limit) => ctx.runMutation(internal.x.state.usageReserve, { key, amount, limit }),
    release: async (key, amount) => {
      await ctx.runMutation(internal.x.state.usageRelease, { key, amount });
    },
  };
}
