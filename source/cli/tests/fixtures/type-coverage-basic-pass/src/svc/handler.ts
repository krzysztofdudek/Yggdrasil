// Lattice row: TYPE-COVERED. Matches only the `svc` type (src/svc/**) — no
// node maps this file, but exactly one classifying type does, which is enough
// to satisfy type-level coverage. Isolated here without the sibling
// ambiguous/strict-claimed/unmatched files that type-coverage-basic/ also
// carries, so this fixture's run is a clean PASS.
export function handle(): string {
  return 'handled';
}
