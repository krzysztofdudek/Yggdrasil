// Also matched by 'consumer', but — unlike c.ts in this same variant —
// imports nothing at all. The mirror case for never-imports-leaf: a consumer
// file with no outgoing edge to a leaf-typed target must have the negated
// gate attach, while the positive gate (needs-leaf-dependency) must not.
export const plain = 1;
