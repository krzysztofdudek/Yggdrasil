// Lattice row: STRICT-CLAIMED. Matches `special` (enforce: strict) AND `util`
// (src/util/**) — the strict backward scan owns this file (type-strict-orphan,
// since no node maps it) and, with coverage.type_level on, its message is
// enriched with "Also matches: util". No ambiguous-node-type fires for it —
// a strict match always wins the lattice.
export const special = true;
