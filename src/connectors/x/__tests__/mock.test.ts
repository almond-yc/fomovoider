import { describe, expect, it } from "vitest";
import { MOCK_X_SESSION, createMockXConnector } from "../mock";

describe("createMockXConnector", () => {
  it("serves normalized fixture data without credentials", async () => {
    const x = createMockXConnector();
    expect(x.login.kind).toBe("oauth");
    const session = x.login.kind === "oauth" ? await x.login.login() : MOCK_X_SESSION;
    expect((await x.account(session)).me.handle).toBe("XDevelopers");

    const first = await x.feed(session, { since: "2026-11-14T00:00:00Z", limit: 50 });
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.caughtUp).toBe(true);
    const second = await x.feed(session, { since: first.cursor, limit: 50 });
    expect(second).toEqual({ items: [], cursor: first.cursor, caughtUp: true });

    const chats = await x.conversations(session, { limit: 20 });
    expect(chats.items.map((c) => c.id)).toContain("x:1234567890-2244994945");
    const messages = await x.messages(session, "x:1234567890-2244994945", { limit: 20 });
    expect(messages.items).toHaveLength(2);
    expect((await x.send(session, "x:1234567890-2244994945", { text: "hi" })).isMine).toBe(true);
  });
});
