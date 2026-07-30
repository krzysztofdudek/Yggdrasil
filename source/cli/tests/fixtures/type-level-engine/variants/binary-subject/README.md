# variants/binary-subject

Overlays a `yg-architecture.yaml` that adds ONE new type, `pics` (matches
`src/pics/**`), attaching exactly one LLM per-file rule, `prose-rule` — plus
that aspect's own `content.md`/`yg-aspect.yaml`, and two source files under
`src/pics/`: `readme.md` (text — the rule genuinely enforces here) and
`logo.png` (binary — a prose rule can never review it).

Pins the fix-round-1 critical case: before the fix, `logo.png` had NO drop
recorded for `prose-rule` (the binary-subject skip in `pairs.ts`'s nodeless
enumeration was silent), so the old "declared minus dropped" derivation
counted it as enforced too — `prose-rule (2)` when only ONE real pair
(`readme.md`) exists, `logo.png` never named in the zero-enforcement line even
though nothing runs on it, and `yg context --file` on `logo.png` printed
`[enforced]` with no reason at all.
