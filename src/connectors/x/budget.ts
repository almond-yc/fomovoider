export type BudgetKind = "postReads" | "dmEventReads" | "writes";

export interface UsageStore {
  used(key: string): Promise<number>;
  reserve(key: string, amount: number, limit: number): Promise<number>;
  release(key: string, amount: number): Promise<void>;
}

export class MemoryUsageStore implements UsageStore {
  private readonly counts = new Map<string, number>();

  async used(key: string): Promise<number> {
    return this.counts.get(key) ?? 0;
  }

  async reserve(key: string, amount: number, limit: number): Promise<number> {
    const used = this.counts.get(key) ?? 0;
    const granted = Math.max(0, Math.min(amount, limit - used));
    this.counts.set(key, used + granted);
    return granted;
  }

  async release(key: string, amount: number): Promise<void> {
    if (amount > 0) this.counts.set(key, Math.max(0, (this.counts.get(key) ?? 0) - amount));
  }
}

export class DailyBudget {
  constructor(
    private readonly limits: Record<BudgetKind, number>,
    private readonly store: UsageStore,
    private readonly now: () => number,
  ) {}

  private key(userId: string, kind: BudgetKind): string {
    return `x:${userId}:${kind}:${new Date(this.now()).toISOString().slice(0, 10)}`;
  }

  async remaining(userId: string, kind: BudgetKind): Promise<number> {
    return Math.max(0, this.limits[kind] - (await this.store.used(this.key(userId, kind))));
  }

  reserve(userId: string, kind: BudgetKind, amount: number): Promise<number> {
    return this.store.reserve(this.key(userId, kind), amount, this.limits[kind]);
  }

  async release(userId: string, kind: BudgetKind, amount: number): Promise<void> {
    if (amount > 0) await this.store.release(this.key(userId, kind), amount);
  }

  nextResetAt(): number {
    const d = new Date(this.now());
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }
}
