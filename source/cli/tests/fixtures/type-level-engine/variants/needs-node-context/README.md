# variants/needs-node-context

Overlays a `yg-architecture.yaml` that adds ONE new type, `crashy` (matches
`src/crashy/**`), attaching exactly one deterministic per-file rule,
`needs-node-context` — plus that aspect's own `check.mjs`/`yg-aspect.yaml`,
and one source file, `src/crashy/a.ts`, that matches the type and owns no
component of its own.

`needs-node-context`'s check reads `ctx.node` unconditionally. That is a
structurally impossible ask for a component-free file — there is no
`yg-node.yaml` behind it to back `ctx.node` — so every `yg check --approve`
attempt against `src/crashy/a.ts` runtime-errors identically, forever, until
the check is rewritten to read only `ctx.subject`/`ctx.fs` or the file is
given a component of its own.

Pins the fill→check handoff: `yg check --approve` learns the disposition from
its OWN attempt to run the check and its post-fill report names it plainly
("cannot run — it needs component context …") instead of the bare
"unverified" caveat a plain, never-filled `yg check` still has to fall back
to.
