export interface XConfig {
  clientId: string;
  clientSecret?: string;
  callbackUrl?: string;
  dailyPostReadBudget: number;
  dailyDmEventReadBudget: number;
  dailyWriteBudget: number;
}

export const DEFAULT_DAILY_POST_READ_BUDGET = 60;
export const DEFAULT_DAILY_DM_EVENT_READ_BUDGET = 10;
export const DEFAULT_DAILY_WRITE_BUDGET = 10;

function intFromEnv(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

export function xConfigFromEnv(env: Record<string, string | undefined>): XConfig {
  const clientId = env.X_CLIENT_ID;
  if (!clientId) throw new Error("X_CLIENT_ID is not set");
  return {
    clientId,
    clientSecret: env.X_CLIENT_SECRET || undefined,
    callbackUrl: env.X_CALLBACK_URL || undefined,
    dailyPostReadBudget: intFromEnv("X_DAILY_POST_READ_BUDGET", env.X_DAILY_POST_READ_BUDGET, DEFAULT_DAILY_POST_READ_BUDGET),
    dailyDmEventReadBudget: intFromEnv("X_DAILY_DM_EVENT_READ_BUDGET", env.X_DAILY_DM_EVENT_READ_BUDGET, DEFAULT_DAILY_DM_EVENT_READ_BUDGET),
    dailyWriteBudget: intFromEnv("X_DAILY_WRITE_BUDGET", env.X_DAILY_WRITE_BUDGET, DEFAULT_DAILY_WRITE_BUDGET),
  };
}
