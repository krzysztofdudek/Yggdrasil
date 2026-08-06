// Lattice row: AMBIGUOUS. Matches BOTH `svc` (src/svc/**) and `util` (via its
// any_of's second clause, which names this exact file) — two non-strict types,
// no strict type — the deliberate overlap the ambiguous-node-type check exists
// to catch.
export const overlap = true;
