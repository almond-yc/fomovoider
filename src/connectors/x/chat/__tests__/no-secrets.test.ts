/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The server holds X Chat keys in one place. Only convex/x/chatNode.ts may
// take a passcode or handle private keys (it unlocks, exports, seals and
// imports them), only it, chatKeys.ts and the schema may touch the sealed
// keys column, and no server file logs a passcode or keys.
const SERVER_DIRS = ["convex", "src/connectors/x/chat"];
const KEY_HOLDER = "convex/x/chatNode.ts";
const SEALED_KEYS = new Set([KEY_HOLDER, "convex/x/chatKeys.ts", "convex/x/schema.ts"]);
const SECRET = /\b(pin|passcode|privateKeys?|secretKeys?|exportKeys|importKeys|export_keys|import_keys)\s*[:=(]/i;
const LOGGED_SECRET = /console\.\w+\([^)]*\b(passcode|pin|keys|exported|encryptedKeys)\b/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "_generated" || name === "__tests__" ? [] : files(path);
    return /\.(ts|tsx|json)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

function lines() {
  return SERVER_DIRS.flatMap(files).flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .map((text, i) => ({ path, line: i + 1, text }))
      .filter(({ text }) => !text.trim().startsWith("//")),
  );
}

describe("X Chat secrets on the server", () => {
  it("only chatNode.ts takes a passcode or handles private keys", () => {
    expect(lines().filter(({ path, text }) => path !== KEY_HOLDER && SECRET.test(text))).toEqual([]);
  });

  it("only the key store touches the sealed keys", () => {
    expect(lines().filter(({ path, text }) => !SEALED_KEYS.has(path) && /encryptedKeys/.test(text))).toEqual([]);
  });

  it("no server file logs a passcode or keys", () => {
    expect(lines().filter(({ text }) => LOGGED_SECRET.test(text))).toEqual([]);
  });
});
