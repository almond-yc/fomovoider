import { describe, expect, it } from "vitest";
import { xConfigFromEnv } from "../config";

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
      dailyWriteBudget: 10,
    });
  });

  it("defaults budgets so $20 of credits lasts a month", () => {
    const c = xConfigFromEnv({ X_CLIENT_ID: "id" });
    const worstCaseDaily = c.dailyPostReadBudget * 0.005 + c.dailyDmEventReadBudget * 0.01 + c.dailyWriteBudget * 0.015;
    expect(worstCaseDaily * 31).toBeLessThanOrEqual(20);
  });

  it("requires X_CLIENT_ID and validates numbers", () => {
    expect(() => xConfigFromEnv({})).toThrow(/X_CLIENT_ID/);
    expect(() => xConfigFromEnv({ X_CLIENT_ID: "id", X_DAILY_WRITE_BUDGET: "-1" })).toThrow(/X_DAILY_WRITE_BUDGET/);
  });
});
