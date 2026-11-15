// The X API's juicebox_config carries the realm auth tokens next to the realm
// settings ("token_map", sometimes inside a JSON string). The Chat XDK asks
// for one token per realm by its hex id.
export function realmTokenFrom(juiceboxConfig: unknown, realmId: string): string | undefined {
  const wanted = realmId.toLowerCase();
  const seen = new Set<unknown>();
  const visit = (value: unknown): string | undefined => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed.startsWith("{")) return undefined;
      try {
        return visit(JSON.parse(trimmed));
      } catch {
        return undefined;
      }
    }
    if (!value || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    const record = value as Record<string, unknown>;
    const map = record.token_map;
    const tokens = typeof map === "string" ? safeParse(map) : map;
    if (tokens && typeof tokens === "object") {
      for (const [key, token] of Object.entries(tokens as Record<string, unknown>)) {
        if (key.toLowerCase() === wanted && typeof token === "string") return token;
      }
    }
    for (const child of Object.values(record)) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(juiceboxConfig);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
