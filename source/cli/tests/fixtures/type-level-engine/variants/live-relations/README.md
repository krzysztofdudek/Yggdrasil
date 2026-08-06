# variants/live-relations

Overlays `src/consumer/c.ts` with a REAL import of `src/leaf/a.ts` (a
type-covered `leaf` file), adds a second consumer file `plain.ts` with no such
import, and attaches one more aspect to `consumer`: `never-imports-leaf`, the
negated counterpart of the base fixture's `needs-leaf-dependency` (`when: {
not: { relations: { uses: { target_type: leaf } } } }`).

Every other test in this repo drives `relations:`-gated applicability through
a hand-built `TypedEdgeIndex` passed directly to `computeTypeAspectCascade` —
never through a real parsed import and the real CLI. This variant exists so
one can: the graph is loaded, the source is parsed, imports are resolved, and
the resulting edge index is what the `relations:` atom is answered from —
proving the wiring from real source to the applicability predicate end to
end, not just the predicate's own logic in isolation.

Expected on `c.ts` (imports a leaf file): `needs-leaf-dependency` attaches,
`never-imports-leaf` does not.
Expected on `plain.ts` (imports nothing): `never-imports-leaf` attaches,
`needs-leaf-dependency` does not.
