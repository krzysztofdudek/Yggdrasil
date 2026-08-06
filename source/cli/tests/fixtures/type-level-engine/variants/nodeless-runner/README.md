# variants/nodeless-runner

Six real, on-disk `check.mjs` fixtures exercising the deterministic runner's
nodeless (component-free) unit directly: `reads-self`, `reads-permitted-sibling`,
`reads-forbidden`, `touches-node`, `touches-graph`, `lists-dir`.

None of these aspects is attached anywhere in `yg-architecture.yaml` — the
tests that use this variant drive them straight through `runStructureAspect`
with a hand-built `unit: { kind: 'file', ... }`, never through the full
pairs/effective-aspect cascade, so no architecture wiring is needed and this
variant never perturbs the base fixture's own effective-aspect sets (leaving
them unattached also keeps the `orphaned-aspect` validator quiet — it fires on
any aspect not referenced by a node, architecture type, or flow, which these
deliberately are not, since no test here ever runs `validate()`/`yg check`
against the merged copy). The base fixture's own `src/leaf/a.ts`,
`src/helper/h.ts`, and `src/forbidden/x.ts` (real files, not this variant's)
stand in as the subject, a permitted sibling, and a forbidden sibling
respectively.
