# variants/cyclic-type

Overlays a `yg-architecture.yaml` that adds one new type, `cyclic`, matching
`src/cyclic/**` with no component ever mapping it, plus two new deterministic
aspects (`cyclic-a`, `cyclic-b`) forming a mutual `implies` cycle. Pins that
every surface answering about a type-covered file whose type's rules cannot
be worked out because of the cycle says so honestly — naming the cycle —
instead of falsely claiming the file has zero enforcement: `yg context
--file` and `yg owner --file` (both per-file), and `yg check`'s own per-type
block and repo-wide rollup (the whole-run surface).
