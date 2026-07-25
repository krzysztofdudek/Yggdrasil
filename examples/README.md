# Examples

Self-contained example projects — each directory is a standalone app with
source code and its own `.yggdrasil/` graph. They fall into two groups: the
**keyless** examples run with no API key (the free, local layer — deterministic
`check.mjs` rules and the built-in relation check), and the **reviewer**
examples show the LLM layer.

Each of the four keyless examples has its own `README.md` with the one edit that
breaks the rule and the exact refusal you will see. The two reviewer examples are
described here on this page and have no separate README — their whole point is the
pair of commands below.

## Keyless examples — no API key, run in seconds

Only the free, local layer: no reviewer, no key, no network. The deterministic
verdicts are cached in a gitignored file, filled for free by
`yg check --approve --only-deterministic`; the relation check runs live on every
`yg check`.

### `no-secrets-in-logs/` — a script rule catches a PCI leak

A fintech payments API. A deterministic rule refuses any log call that
references a raw secret or cardholder field (`password`, `pan`, `cvv`,
`token`, …) — a real PCI-DSS concern.

```bash
cd examples/no-secrets-in-logs
yg check --approve --only-deterministic   # free, keyless — fills the local verdict
yg check                                  # PASS
```

### `layered-architecture/` — component boundaries enforced live

A ride-hailing backend in three layers (`web → domain → data`). The built-in
relation check refuses a handler that reaches into the data layer directly —
live, on every `yg check`, with no lock and no key.

```bash
cd examples/layered-architecture
yg check    # PASS — layering respected; break it and check refuses live
```

### `pure-transforms/` — the same layer, on Python

An analytics/ETL pipeline written in Python. A deterministic rule keeps
transform functions reproducible (no wall-clock reads, no randomness) — proving
the checks work beyond TypeScript.

```bash
cd examples/pure-transforms
yg check --approve --only-deterministic
yg check    # PASS
```

### `checkout-flow/` — one rule on a business process, enforced on every step

An e-commerce checkout. A single rule attached to the `checkout` flow ("every
step emits a telemetry event") is enforced on all three steps — declared once,
on the flow, and propagated to every participant.

```bash
cd examples/checkout-flow
yg check --approve --only-deterministic
yg check    # PASS
```

## Reviewer examples — the LLM layer

These use an LLM aspect, so `yg check --approve` needs a configured reviewer.
The verdict is committed in the lock, so plain `yg check` reproduces it with no
key (exactly what CI sees).

### `passing/` — clean graph

A small order API where all aspects are satisfied.

```bash
cd examples/passing
yg check    # PASS — everything clean
yg tree     # see the graph
```

### `failing/` — deliberate violation

Same project, but the payment service is missing audit logging — a violation of
the `requires-audit` aspect. The reviewer defaults to Claude Code; run
`yg init` to switch providers.

```bash
cd examples/failing
yg check                     # FAIL — payments never approved
yg check --approve           # reviewer rejects: audit logging missing
```

Fix `src/payments.ts` by adding audit logging, then re-run `yg check --approve`
to see it pass.
