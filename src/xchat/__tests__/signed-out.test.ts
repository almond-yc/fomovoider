import { type ReactElement, createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = { isLoading: false, isAuthenticated: false };
const queries: { name: string; args: unknown }[] = [];

vi.mock("convex/react", () => ({
  useConvexAuth: () => auth,
  useQuery: (ref: unknown, args: unknown) => {
    queries.push({ name: String((ref as Record<symbol, unknown>)[Symbol.for("functionName")] ?? ref), args });
    return undefined;
  },
  useAction: () => vi.fn(),
  useConvex: () => ({ query: vi.fn() }),
}));
vi.mock("react-native", () => ({ View: () => null }));
vi.mock("react-native-webview", () => ({ WebView: () => null }));
vi.mock("expo-asset", () => ({ Asset: { loadAsync: vi.fn() } }));
vi.mock("expo-file-system", () => ({ File: vi.fn() }));
vi.mock("../passcode-store", () => ({
  biometricPreference: vi.fn(),
  biometricsAvailable: () => false,
  forgetPasscode: vi.fn(),
  hasSavedPasscode: vi.fn(),
  readPasscode: vi.fn(),
  savePasscode: vi.fn(),
  setBiometricPreference: vi.fn(),
}));

const { XChatProvider, useXChatInbox, useXChatMessages } = await import("../index");
const { renderToString } = (await import("react-dom/server" as string)) as { renderToString(node: ReactElement): string };

const locked = {
  id: "x:1001-2002",
  platform: "x" as const,
  participants: [{ id: "x:1001", platform: "x", handle: "alice", displayName: "Alice" }],
  unavailable: { reason: "locked" },
  updatedAt: 0,
};

function Screen() {
  useXChatInbox([locked]);
  useXChatMessages(locked);
  return null;
}

function render() {
  queries.length = 0;
  renderToString(createElement(XChatProvider, null, createElement(Screen)));
  return queries;
}

describe("X Chat before sign-in", () => {
  beforeEach(() => {
    auth.isAuthenticated = false;
  });

  it("skips every query in the provider and hooks while no viewer is signed in", () => {
    const calls = render();
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls.every((c) => c.args === "skip")).toBe(true);
  });

  it("runs them once a viewer is signed in", () => {
    auth.isAuthenticated = true;
    const calls = render();
    expect(calls.filter((c) => c.args === "skip")).toEqual([]);
    expect(calls.some((c) => (c.args as { conversationId?: string } | undefined)?.conversationId === locked.id)).toBe(true);
  });
});
