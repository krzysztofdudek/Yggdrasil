# Core Operations Unit Tests — Responsibility

These 12 test files guard two groups of operations:

**(1) Trust model pipeline** — approve, drift detection, validation, aspect propagation, check, impact, dependency-resolver, and LLM reviewer. These form a pipeline where a bug in any one operation silently corrupts downstream decisions. Drift detection feeds approval; approval depends on validation; validation depends on aspect propagation; all depend on correct dependency resolution. Silent corruption is the risk — which is why these tests are grouped here rather than scattered across individual operation nodes.

**(2) Supporting operations** — migrator and node-selector. These are independent of the trust model pipeline. Bugs produce wrong but visible outcomes (incorrect migration output, wrong node selected) rather than silent graph corruption. They are grouped here because their correctness is still critical to overall CLI reliability, but the failure mode differs: visible and recoverable rather than silently propagating.
