import { describe, expect, it } from "vitest";
import { DEFAULT_DAILY_BUDGET_SPLIT_USD, xConfigFromEnv } from "../config";

describe("xConfigFromEnv", () => {
  it("reads client credentials, callback and budgets", () => {
    expect(
      xConfigFromEnv({
        X_CLIENT_ID: "id",
        X_CLIENT_SECRET: "secret",
        X_CALLBACK_URL: "http://127.0.0.1:8787/callback",
        X_DAILY_POST_READ_BUDGET: "100",
      }),
    ).toEqual({
      clientId: "id",
      clientSecret: "secret",
      callbackUrl: "http://127.0.0.1:8787/callback",
      dailyPostReadBudget: 100,
      dailyDmEventReadBudget: 10,
      dailyChatEventReadBudget: 36,
      dailyWriteBudget: 5,
    });
  });

  it("defaults budgets so $20 of credits lasts a month", () => {
    const c = xConfigFromEnv({ X_CLIENT_ID: "id" });
    const worstCaseDaily =
      c.dailyPostReadBudget * 0.005 + c.dailyDmEventReadBudget * 0.01 + c.dailyChatEventReadBudget * 0.01 + c.dailyWriteBudget * 0.015;
    expect(worstCaseDaily * 31).toBeLessThanOrEqual(20);
  });

  it("gives X Chat the largest share of the default split", () => {
    const c = xConfigFromEnv({ X_CLIENT_ID: "id" });
    expect(c).toMatchObject({ dailyPostReadBudget: 20, dailyChatEventReadBudget: 36 });
    expect(Math.max(...Object.values(DEFAULT_DAILY_BUDGET_SPLIT_USD))).toBe(DEFAULT_DAILY_BUDGET_SPLIT_USD.chatEventReads);
  });

  it("takes the split in dollars from X_DAILY_BUDGET_SPLIT_USD, with per-kind counts still winning", () => {
    const c = xConfigFromEnv({
      X_CLIENT_ID: "id",
      X_DAILY_BUDGET_SPLIT_USD: "chatEventReads=0.2, postReads=0.3",
      X_DAILY_WRITE_BUDGET: "7",
    });
    expect(c).toMatchObject({ dailyChatEventReadBudget: 20, dailyPostReadBudget: 60, dailyDmEventReadBudget: 10, dailyWriteBudget: 7 });
    expect(() => xConfigFromEnv({ X_CLIENT_ID: "id", X_DAILY_BUDGET_SPLIT_USD: "feed=1" })).toThrow(/X_DAILY_BUDGET_SPLIT_USD/);
    expect(() => xConfigFromEnv({ X_CLIENT_ID: "id", X_DAILY_BUDGET_SPLIT_USD: "writes=-1" })).toThrow(/X_DAILY_BUDGET_SPLIT_USD/);
  });

  it("requires X_CLIENT_ID and validates numbers", () => {
    expect(() => xConfigFromEnv({})).toThrow(/X_CLIENT_ID/);
    expect(() => xConfigFromEnv({ X_CLIENT_ID: "id", X_DAILY_WRITE_BUDGET: "-1" })).toThrow(/X_DAILY_WRITE_BUDGET/);
  });
});
