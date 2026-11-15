import { beforeEach, vi } from "vitest";

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("Live network access is not allowed in tests");
  });
});
