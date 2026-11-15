// The adapter's only durable state: which Convex accounts it serves, on which
// bridge, as which remote identity. Rooms are re-read from Matrix on demand.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Person } from "../../../src/connectors/types.js";

export interface AccountState {
  platform: string;
  loginId?: string;
  me?: Person;
}

export class StateFile {
  accounts: Record<string, AccountState> = {};

  constructor(private readonly path?: string) {
    if (!path) return;
    try {
      this.accounts = JSON.parse(readFileSync(path, "utf8")).accounts ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify({ accounts: this.accounts }, null, 2));
    renameSync(`${this.path}.tmp`, this.path);
  }
}
