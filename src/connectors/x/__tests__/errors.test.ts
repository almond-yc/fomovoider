import { describe, expect, it } from "vitest";
import { HOME, MENTIONS, NOW, fixture, setup, sliced } from "./helpers";

const resetSeconds = Math.floor(NOW / 1000) + 900;
const empty = { meta: { result_count: 0 } };

describe("error mapping", () => {
  it("429 becomes rate_limited with retryAt from x-rate-limit-reset", async () => {
    const { connector, x, session } = setup();
    x.on("GET", MENTIONS, { status: 429, body: fixture("error-rate-limited"), headers: { "x-rate-limit-remaining": "0", "x-rate-limit-reset": String(resetSeconds) } });
    await expect(connector.feed(session, { since: "x1|1|1|", limit: 10 })).rejects.toMatchObject({
      error: { kind: "rate_limited", retryAt: new Date(resetSeconds * 1000).toISOString() },
    });
  });

  it("an exhausted rate-limit window is enforced locally until reset", async () => {
    const { connector, x, session, clock } = setup();
    x.on("GET", MENTIONS, { body: empty, headers: { "x-rate-limit-limit": "300", "x-rate-limit-remaining": "0", "x-rate-limit-reset": String(resetSeconds) } });
    x.on("GET", HOME, { body: empty });
    await connector.feed(session, { since: "x1|1|1|", limit: 10 });
    await expect(connector.feed(session, { since: "x1|1|1|", limit: 10 })).rejects.toMatchObject({ error: { kind: "rate_limited" } });
    expect(x.callsTo(MENTIONS)).toHaveLength(1);
    clock.set(resetSeconds * 1000 + 1);
    await connector.feed(session, { since: "x1|1|1|", limit: 10 });
    expect(x.callsTo(MENTIONS)).toHaveLength(2);
  });

  it.each([
    ["HTTP 402", 402, fixture("error-out-of-credits")],
    ["a usage-capped 429", 429, fixture("error-usage-capped")],
  ])("%s (out of X credits) becomes budget_exhausted", async (_label, status, body) => {
    const { connector, x, session } = setup();
    x.on("GET", MENTIONS, { status, body });
    await expect(connector.feed(session, { since: "x1|1|1|", limit: 10 })).rejects.toMatchObject({ error: { kind: "budget_exhausted" } });
  });

  it("other HTTP errors become platform errors with X's detail", async () => {
    const { connector, x, session } = setup();
    x.on("GET", "/2/dm_events", { status: 403, body: { title: "Forbidden", detail: "You are not permitted to perform this action.", type: "about:blank" } });
    await expect(connector.conversations(session, { limit: 10 })).rejects.toMatchObject({
      error: { kind: "platform", message: "X: You are not permitted to perform this action." },
    });
  });

  it("a fetch failure becomes network", async () => {
    const { connector, session } = setup({ connector: { fetch: () => Promise.reject(new TypeError("Network request failed")) } });
    await expect(connector.account(session)).rejects.toMatchObject({ error: { kind: "network" } });
  });

  it("reads are retried once after a 5xx, writes never", async () => {
    const { connector, x, session, sleeps } = setup();
    x.once("GET", "/2/dm_events", { status: 503, body: { title: "Service Unavailable" } });
    x.on("GET", "/2/dm_events", { body: fixture("dm-events") });
    await connector.conversations(session, { limit: 10 });
    expect(x.callsTo("/2/dm_events")).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    x.on("POST", "/2/tweets", { status: 503, body: { title: "Service Unavailable" } });
    await expect(connector.reply!(session, "x:1", { text: "hi" })).rejects.toMatchObject({ error: { kind: "platform" } });
    expect(x.callsTo("/2/tweets")).toHaveLength(1);
  });
});

describe("daily budget", () => {
  it("charges expanded posts against the cap and returns unused capacity", async () => {
    const { connector, x, session } = setup({ config: { dailyPostReadBudget: 20 } });
    x.on("GET", MENTIONS, { body: fixture("mentions") });
    x.on("GET", HOME, { body: fixture("home-timeline") }, { body: empty });
    await connector.feed(session, { since: "x1|1|1|", limit: 50 });
    expect(x.callsTo(MENTIONS).map((c) => c.url.searchParams.get("max_results"))).toEqual(["5"]);
    expect(x.callsTo(HOME).map((c) => c.url.searchParams.get("max_results"))).toEqual(["4", "6"]);
    expect(await connector.remainingBudget("2244994945", "postReads")).toBe(20 - 1 - 4 - 2);
  });

  it("never records more than the cap, then throws budget_exhausted with resetsAt", async () => {
    const { connector, x, session } = setup({ config: { dailyPostReadBudget: 2 } });
    x.on("GET", MENTIONS, sliced("mentions"));
    x.on("GET", HOME, sliced("home-timeline", { nextToken: null }));
    await connector.feed(session, { since: "x1|1|1|", limit: 50 });
    expect(x.callsTo(MENTIONS)).toHaveLength(0);
    expect(x.callsTo(HOME)[0]!.url.searchParams.get("max_results")).toBe("1");
    expect(await connector.remainingBudget("2244994945", "postReads")).toBe(0);
    await expect(connector.feed(session, { since: "x1|1|1|", limit: 50 })).rejects.toMatchObject({
      error: { kind: "budget_exhausted", resetsAt: "2026-11-16T00:00:00.000Z" },
    });
  });

  it("reserves writes atomically so parallel sends can't overspend", async () => {
    const { connector, x, session } = setup({ config: { dailyWriteBudget: 1 } });
    x.on("POST", "/2/tweets", { status: 201, body: fixture("create-post") });
    x.on("POST", /\/messages$/, { status: 201, body: fixture("create-dm") });
    await connector.account(session);
    const results = await Promise.allSettled([
      connector.reply!(session, "x:1", { text: "hi" }),
      connector.send(session, "x:1234567890-2244994945", { text: "hi" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(x.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("counts expanded quoted and reposted posts as reads", async () => {
    const { connector, x, session } = setup({ config: { dailyPostReadBudget: 100 } });
    x.on("GET", MENTIONS, { body: empty });
    const home = fixture("home-timeline");
    delete home.meta.next_token;
    x.on("GET", HOME, { body: home });
    await connector.feed(session, { since: "x1|1|1|", limit: 50 });
    expect(await connector.remainingBudget("2244994945", "postReads")).toBe(100 - 4 - 2);
  });

  it("caps DM event reads and writes separately and does not count failed writes", async () => {
    const { connector, x, session } = setup({ config: { dailyDmEventReadBudget: 4, dailyWriteBudget: 1 } });
    x.on("GET", "/2/dm_events", { body: fixture("dm-events") });
    await connector.conversations(session, { limit: 50 });
    expect(x.callsTo("/2/dm_events")[0]!.url.searchParams.get("max_results")).toBe("4");
    await expect(connector.conversations(session, { limit: 50 })).rejects.toMatchObject({ error: { kind: "budget_exhausted" } });
    x.on("POST", "/2/tweets", { status: 403, body: fixture("error-reply-not-summoned") }, { status: 201, body: fixture("create-post") });
    await expect(connector.reply!(session, "x:1", { text: "hi" })).rejects.toMatchObject({ error: { kind: "platform" } });
    await connector.reply!(session, "x:2", { text: "hi" });
    await expect(connector.reply!(session, "x:3", { text: "hi" })).rejects.toMatchObject({ error: { kind: "budget_exhausted" } });
  });
});
