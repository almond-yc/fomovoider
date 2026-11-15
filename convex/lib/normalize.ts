export function isoDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ISO date: ${value}`);
  return date.toISOString();
}

export function assertNamespaced(id: string, platform: string) {
  if (!id.startsWith(`${platform}:`)) {
    throw new Error(`Id ${id} is not namespaced to platform ${platform}`);
  }
}
