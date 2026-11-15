import { describe, expect, it } from "vitest";
import { HOME, MENTIONS, fixture, setup, sliced } from "./helpers";

const empty = { meta: { result_count: 0 } };
const lastPage = (name: "home-timeline" | "mentions") => {
  const body = fixture(name);
  delete body.meta.next_token;
  return body;
};

describe("feed", () => {
  it("first run: reads mentions and the home timeline from the since timestamp, excluding replies and reposts", async () => {
    const { connector, x, session } = setup();
    x.on("GET", MENTIONS, { body: fixture("mentions") });
    x.on("GET", HOME, { body: lastPage("home-timeline") });
    const page = await connector.feed(session, { since: "2026-11-14T20:00:00Z", limit: 50 });

    const home = x.callsTo(HOME)[0]!.url.searchParams;
    expect(home.get("start_time")).toBe("2026-11-14T20:00:00.000Z");
    expect(home.has("since_id")).toBe(false);
    expect(home.get("exclude")).toBe("replies,retweets");
    expect(home.get("expansions")).toContain("referenced_tweets.id");
    expect(home.get("media.fields")).toContain("alt_text");
    expect(x.callsTo(MENTIONS)[0]!.url.searchParams.get("start_time")).toBe("2026-11-14T20:00:00.000Z");
    expect(page.caughtUp).toBe(true);
    expect(page.cursor).toBe("x1|1857000000000000006|1857000000000000007|2026-11-14T20:00:00.000Z");
  });

  it("later runs pass the stored cursor back as since_id and keep it when nothing is new", async () => {
    const { connector, x, session } = setup();
    x.on("GET", MENTIONS, { body: empty });
    x.on("GET", HOME, { body: empty });
    const cursor = "x1|1857000000000000006|1857000000000000007|2026-11-14T20:00:00.000Z";
    const page = await connector.feed(session, { since: cursor, limit: 50 });
    expect(x.callsTo(HOME)[0]!.url.searchParams.get("since_id")).toBe("1857000000000000006");
    expect(x.callsTo(HOME)[0]!.url.searchParams.has("start_time")).toBe(false);
    expect(x.callsTo(MENTIONS)[0]!.url.searchParams.get("since_id")).toBe("1857000000000000007");
    expect(page).toEqual({ items: [], cursor, caughtUp: true });
  });

  it("follows pagination until X has nothing older than since", async () => {
    const { connector, x, session } = setup();
    x.on("GET", MENTIONS, { body: empty });
    x.on("GET", HOME, { body: fixture("home-timeline") }, { body: { data: [], meta: { result_count: 0 } } });
    const page = await connector.feed(session, { since: "x1|1|1|", limit: 50 });
    expect(x.callsTo(HOME)).toHaveLength(2);
    expect(x.callsTo(HOME)[1]!.url.searchParams.get("pagination_token")).toBe("7140dibdnow9c7btw421dyz6jism75z99gyxd8egarsc4");
    expect(page.caughtUp).toBe(true);
  });

  it("reads mentions and the home timeline in the same round so neither starves the other", async () => {
    const { connector, x, session } = setup();
    x.on("GET", MENTIONS, { body: fixture("mentions") });
    x.on("GET", HOME, { body: fixture("home-timeline") }, { body: empty });
    const page = await connector.feed(session, { since: "x1|1|1|", limit: 50 });
    expect(x.callsTo(MENTIONS).map((c) => c.url.searchParams.get("max_results"))).toEqual(["25"]);
    expect(x.callsTo(HOME).map((c) => c.url.searchParams.get("max_results"))).toEqual(["24", "45"]);
    expect(page.caughtUp).toBe(true);
  });

  it("stops at limit and reports that it is not caught up", async () => {
    const { connector, x, session } = setup();
    x.on("GET", MENTIONS, sliced("mentions", { nextToken: "more-mentions" }));
    x.on("GET", HOME, sliced("home-timeline"));
    const page = await connector.feed(session, { since: "x1|1|1|", limit: 6 });
    expect(page.items.length).toBeLessThanOrEqual(6);
    expect(page.caughtUp).toBe(false);
  });

  it("deduplicates a post that is both a mention and in the home timeline", async () => {
    const { connector, x, session } = setup();
    x.on("GET", MENTIONS, { body: fixture("mentions") });
    const home = lastPage("home-timeline");
    home.data.unshift(fixture("mentions").data[0]);
    home.includes.users.push(...fixture("mentions").includes.users);
    x.on("GET", HOME, { body: home });
    const page = await connector.feed(session, { since: "x1|1|1|", limit: 50 });
    expect(page.items.filter((p) => p.id === "x:1857000000000000007")).toHaveLength(1);
  });

  it("can include replies and reposts", async () => {
    const { connector, x, session } = setup({ connector: { feedExclude: [] } });
    x.on("GET", MENTIONS, { body: empty });
    x.on("GET", HOME, { body: empty });
    await connector.feed(session, { since: "x1|1|1|", limit: 10 });
    expect(x.callsTo(HOME)[0]!.url.searchParams.has("exclude")).toBe(false);
  });

  it("rejects a cursor it did not issue", async () => {
    const { connector, session } = setup();
    await expect(connector.feed(session, { since: "garbage", limit: 10 })).rejects.toMatchObject({ error: { kind: "platform" } });
  });
});
