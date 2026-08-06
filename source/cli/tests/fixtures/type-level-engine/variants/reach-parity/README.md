# variants/reach-parity

A type-covered file (`reach-leaf`, matching `src/reach/leaf/**`) whose
architecture relations restrict it to depending on `reach-parent-type` only
(`relationDefault: deny`). Two real components exist under
`src/reach/parent/`: `reach-parent` maps the WHOLE directory, and a nested
`reach-parent/child` maps one specific file inside it (`child.ts`) as
`reach-child-type` — a type `reach-leaf` may NOT depend on.

Two deterministic aspects, both attached to `reach-leaf`:

- `reach-parent-file-rule` reads `src/reach/parent/foo.ts` — genuinely owned
  by `reach-parent`, a permitted type. Must be admitted.
- `reach-child-file-rule` reads `src/reach/parent/child.ts` — genuinely owned
  by `reach-child-type` (child-wins), a forbidden type, even though the file
  sits inside `reach-parent`'s mapped directory. Must be refused.

Pins that the type-covered read allowance resolves ownership with the SAME
child-wins authority the live type gate uses, rather than admitting anything
a permitted parent's raw mapping entry textually covers. Also used to pin
that a component-free pair, once approved, reads back verified on a later
plain `check` — no re-fill, no drift.
