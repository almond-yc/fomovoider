/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Server code may move X Chat ciphertext but must never accept, store or
// return a passcode, a private key or decrypted text. This scans every file
// that runs on Convex or in the server-side connector.
const SERVER_DIRS = ["convex", "src/connectors/x/chat"];
const FORBIDDEN = /\b(pin|passcode|privateKeys?|secretKeys?|exportKeys|importKeys|export_keys|import_keys|plaintext)\s*[:=(]/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "_generated" || name === "__tests__" ? [] : files(path);
    return /\.(ts|tsx|json)$/.test(name) ? [path] : [];
  });
}

describe("X Chat secrets stay on the device", () => {
  it("no server file declares a passcode, key or plaintext field", () => {
    const offenders = SERVER_DIRS.flatMap(files).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .map((line, i) => ({ path, line: i + 1, text: line }))
        .filter(({ text }) => !text.trim().startsWith("//") && FORBIDDEN.test(text)),
    );
    expect(offenders).toEqual([]);
  });
});
