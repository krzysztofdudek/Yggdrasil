# variants/two-covered-files

Adds `src/leaf/b.ts` alongside the base fixture's `src/leaf/a.ts`, plus a
deterministic rule that refuses on `a.ts` only and an LLM rule attached to
`leaf`. Pins that one covered file's refusal must not suppress review of
another covered file matching the same type.
