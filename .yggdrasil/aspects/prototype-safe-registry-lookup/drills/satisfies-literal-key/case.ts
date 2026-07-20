// A string/number literal key is statically visible and auditable — out of scope.
// Must pass.
const REGISTRY: Record<string, number> = { known: 1, other: 2 };

export function lookup(): number {
  return REGISTRY['known'] + REGISTRY['other'];
}
