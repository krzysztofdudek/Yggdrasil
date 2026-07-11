// Routing helper: selects which shard a set of keys maps to.
export function pickShard(keys: string[]): string {
  const sorted = [...keys].sort();
  return sorted[0];
}
