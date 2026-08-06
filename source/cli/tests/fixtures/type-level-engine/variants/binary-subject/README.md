# variants/binary-subject

Overlays a `yg-architecture.yaml` that adds ONE new type, `pics` (matches
`src/pics/**`), attaching exactly one LLM per-file rule, `prose-rule` — plus
that aspect's own `content.md`/`yg-aspect.yaml`, and two source files under
`src/pics/`: `readme.md` (text — the rule genuinely enforces here) and
`logo.png` (binary — a prose rule can never review it).

Pins a real defect class: `logo.png` must always carry a recorded reason
(`prose-rule` dropped as `binary-subject`) rather than silently producing no
drop at all — a silent gap in the nodeless enumeration is indistinguishable
from genuine enforcement to any derivation that infers "enforced" from the
absence of a drop, which would wrongly count `logo.png` as enforced
(`prose-rule (2)` when only ONE real pair — `readme.md` — exists), never name
`logo.png` in the zero-enforcement line even though nothing runs on it, and
make `yg context --file` on `logo.png` print `[enforced]` with no reason at
all.
