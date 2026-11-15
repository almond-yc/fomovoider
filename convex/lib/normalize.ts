// Converts a contract ISODate to the epoch milliseconds stored in every row.
export function epochMs(value: string): number {
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) throw new Error(`Invalid ISO date: ${value}`);
  return ms;
}

export function assertNamespaced(id: string, platform: string) {
  if (!id.startsWith(`${platform}:`)) {
    throw new Error(`Id ${id} is not namespaced to platform ${platform}`);
  }
}
