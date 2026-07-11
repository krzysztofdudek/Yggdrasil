// Routing helper: selects which shard a set of keys maps to.
export function pickShard(keys: string[]): string {
  const index = Math.floor(Math.random() * keys.length);
  return keys[index];
}
