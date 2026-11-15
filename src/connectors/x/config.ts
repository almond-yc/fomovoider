import type { BudgetKind } from "./budget";

export interface XConfig {
  clientId: string;
  clientSecret?: string;
  callbackUrl?: string;
  dailyPostReadBudget: number;
  dailyDmEventReadBudget: number;
  dailyChatEventReadBudget: number;
  dailyWriteBudget: number;
}

// X's pay-per-use price per billed unit, in USD.
export const X_PRICE_USD: Record<BudgetKind, number> = {
  postReads: 0.005,
  dmEventReads: 0.01,
  chatEventReads: 0.01,
  writes: 0.015,
};

// How the daily spend is split across kinds, in USD per X user per UTC day.
// $0.645 a day stays within the $20 of free credits in a 31-day month. X Chat
// takes the largest share; the feed shrinks to make room.
// Override with X_DAILY_BUDGET_SPLIT_USD, e.g. "chatEventReads=0.30,postReads=0.20".
export const DEFAULT_DAILY_BUDGET_SPLIT_USD: Record<BudgetKind, number> = {
  postReads: 0.2,
  dmEventReads: 0.1,
  chatEventReads: 0.3,
  writes: 0.045,
};

const BUDGET_KINDS = Object.keys(X_PRICE_USD) as BudgetKind[];

export function dailyUnits(splitUsd: Record<BudgetKind, number>): Record<BudgetKind, number> {
  return Object.fromEntries(BUDGET_KINDS.map((kind) => [kind, Math.floor(splitUsd[kind] / X_PRICE_USD[kind] + 1e-9)])) as Record<BudgetKind, number>;
}

const DEFAULT_UNITS = dailyUnits(DEFAULT_DAILY_BUDGET_SPLIT_USD);
export const DEFAULT_DAILY_POST_READ_BUDGET = DEFAULT_UNITS.postReads;
export const DEFAULT_DAILY_DM_EVENT_READ_BUDGET = DEFAULT_UNITS.dmEventReads;
export const DEFAULT_DAILY_CHAT_EVENT_READ_BUDGET = DEFAULT_UNITS.chatEventReads;
export const DEFAULT_DAILY_WRITE_BUDGET = DEFAULT_UNITS.writes;

function intFromEnv(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function splitFromEnv(value: string | undefined): Record<BudgetKind, number> {
  const split = { ...DEFAULT_DAILY_BUDGET_SPLIT_USD };
  if (!value) return split;
  for (const part of value.split(",")) {
    const [kind, usd] = part.split("=").map((s) => s.trim());
    const amount = Number(usd);
    if (!BUDGET_KINDS.includes(kind as BudgetKind) || usd === undefined || usd === "" || !Number.isFinite(amount) || amount < 0) {
      throw new Error(`X_DAILY_BUDGET_SPLIT_USD has an invalid entry "${part}"; use kind=usd with kinds ${BUDGET_KINDS.join(", ")}`);
    }
    split[kind as BudgetKind] = amount;
  }
  return split;
}

export function xConfigFromEnv(env: Record<string, string | undefined>): XConfig {
  const clientId = env.X_CLIENT_ID;
  if (!clientId) throw new Error("X_CLIENT_ID is not set");
  const units = dailyUnits(splitFromEnv(env.X_DAILY_BUDGET_SPLIT_USD));
  return {
    clientId,
    clientSecret: env.X_CLIENT_SECRET || undefined,
    callbackUrl: env.X_CALLBACK_URL || undefined,
    dailyPostReadBudget: intFromEnv("X_DAILY_POST_READ_BUDGET", env.X_DAILY_POST_READ_BUDGET, units.postReads),
    dailyDmEventReadBudget: intFromEnv("X_DAILY_DM_EVENT_READ_BUDGET", env.X_DAILY_DM_EVENT_READ_BUDGET, units.dmEventReads),
    dailyChatEventReadBudget: intFromEnv("X_DAILY_CHAT_EVENT_READ_BUDGET", env.X_DAILY_CHAT_EVENT_READ_BUDGET, units.chatEventReads),
    dailyWriteBudget: intFromEnv("X_DAILY_WRITE_BUDGET", env.X_DAILY_WRITE_BUDGET, units.writes),
  };
}

export function dailyBudgetLimits(config: XConfig): Record<BudgetKind, number> {
  return {
    postReads: config.dailyPostReadBudget,
    dmEventReads: config.dailyDmEventReadBudget,
    chatEventReads: config.dailyChatEventReadBudget,
    writes: config.dailyWriteBudget,
  };
}
