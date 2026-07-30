# variants/cyclic-type

Overlays a `yg-architecture.yaml` that adds one new type, `cyclic`, matching
`src/cyclic/**` with no component ever mapping it, plus two new deterministic
aspects (`cyclic-a`, `cyclic-b`) forming a mutual `implies` cycle. Pins that
`yg context --file`, for a type-covered file whose type's rules cannot be
worked out because of an implies cycle, says so honestly — naming the cycle
— instead of falsely claiming the file has zero enforcement.
