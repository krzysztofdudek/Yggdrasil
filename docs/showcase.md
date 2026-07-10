# Yggdrasil Dogfood Showcase

> **Advanced.** A deep dive for readers who already know the basics. New here? Start with [Getting Started](/getting-started) and [How it works](/how-it-works).

This document captures how the Yggdrasil CLI applies its own enforcement rules to itself — a real-world case study of every major feature in production. Use it to calibrate which capabilities are worth introducing early vs. which emerge only as the system grows.

Each section covers one schema feature, how we used it in our self-architecture, its earn-rate (measured in reviewer rejection prevention vs. maintenance overhead), and what we recommend to adopters.

## The Phase 0 Reality

Before writing a single YAML file, we spent the equivalent of several days restructuring code. Here is what we learned:

**Real codebases don't fit ideal types.** Our engine had direct `fs` calls. Our CLI commands imported formatters at the wrong layer. Our utility module had side effects on import. The architecture *described* what we wanted; the code was what we had. We fixed the code first, then installed the architecture.

**Recommendation for adopters:** Treat Phase 0 (code restructuring) as a first-class phase, not a precondition you can skip. Run `yg type-suggest --file <path>` on every file in your project before creating nodes — it tells you which type each file should belong to, and that often surfaces layering problems you didn't know you had. Fix the layering first, then write the architecture. This is not extra work; it is the work.

---

## Feature Showcase

### `path:` atom in `when`

**Used as:** The primary classifier for every node type — `engine` matches `source/cli/src/core/**/*.ts`, `command` matches `source/cli/src/cli/*.ts`, etc.

**Earn-rate: high.** This is the foundation. Without `path:` predicates you have no automatic classification, no strict coverage, and no type-default aspects.

**Recommendation:** Start here. Every project needs at least five type definitions with `path:` predicates before `enforce: strict` becomes useful.

---

### `content:` atom in `when`

**Used as:** `command` type requires `content: "export\\s+function\\s+register[A-Z]\\w*Command\\("` to distinguish command files from other CLI infrastructure.

**Earn-rate: medium.** The `path:` predicate alone could not separate command files from helper files in the same directory. `content:` closed the gap with zero false positives.

**Recommendation:** Use `content:` when files in the same directory have structurally different roles. The pattern is a JavaScript regex matched against file content — keep it anchored to an exported symbol name to stay stable across refactors.

---

### `all_of` / `any_of` / `not` combinators

**Used as:** `command` requires `all_of: [path: cli/*.ts, not: {path: **/*.test.ts}]`. `parser-adapter` requires `all_of` with a path match. `persistence-adapter` uses `any_of` across seven explicit paths.

**Earn-rate: high.** Combinators are essential whenever test files share a directory with production code, or when a type is defined by a fixed list of files rather than a glob.

**Recommendation:** The `not: {path: "**/*.test.ts"}` exclusion is so common it should be in every classifying type that shares directories with tests. For centralized test directories (e.g. `tests/`), use `not: {path: "tests/**"}` instead.

---

### `enforce: strict`

**Used as:** Enabled on all classifying types except `example`, `repo-config`, and `test-fixture`. Any file matching a type's `when` predicate must be in a mapping of that type.

**Earn-rate: high.** Caught 18 violations when we flipped the flag: fixture TypeScript files leaking into the `test-suite` type, GitHub Actions workflows and linting configs not in dedicated ci-config nodes. Each was a real gap, not a false positive.

**Recommendation:** Do not enable `enforce: strict` until coverage is 100% and your type `when` predicates are correct. Run `yg impact --type <id>` for each type first to preview orphans and misplaced files. Fix the gaps, then flip the flag.

---

### `parents:` (allowed parents)

**Used as:** Every type declares which parent types it can appear under — `engine` and `command` only under `module`; `ci-config` under `project` or `module`.

**Earn-rate: medium.** Prevents structural nonsense (a `command` node nested inside a `types` node) without requiring complex validation.

**Recommendation:** Declare `parents:` on every type from day one. It takes ten seconds and prevents hierarchy mistakes that are annoying to untangle later.

---

### `log_required`

**Used as:** Opted in (`log_required: true`) on the production-code types whose changes carry business intent worth recording — `engine`, `command`, the persistence/parser/AST adapters, `migration`, `template`. Documentation, schemas, test suites, fixtures, and CI configs leave it off (the default), so no log entry is demanded before their changes are verified.

**Earn-rate: high.** Targeting the gate at code an LLM reviewer scrutinizes captures the *why* behind real changes where it matters, without accumulating meaningless log entries on config files and test suites.

**Recommendation:** Enable `log_required` only on types whose changes a future maintainer would need explained — domain logic, command handlers, anything with non-obvious business rules. Leave it off (the default) for documentation, schemas, test data, and CI configs.

---

### `aspects:` (type-level defaults — channel 3)

**Used as:** `engine` type automatically applies `deterministic`, `no-direct-fs`, `no-direct-console`, `no-nondeterminism-direct`. `command` type applies `cli-command-contract`, `diagnostic-logging`, `command-contract-shape`. Eight types carry at least one default aspect.

**Earn-rate: high.** This is the architecture-as-policy layer. Adding one aspect to a type applies it to every node of that type, past and future. We used it to roll out `test-deterministic` to all 12 test-suite nodes simultaneously.

**Recommendation:** Add type-level defaults only for aspects that genuinely apply to every node of that type without exception. When you find yourself suppressing an aspect on half the nodes of a type, the aspect probably doesn't belong at the type level.

---

### `aspects:` (node-level — channel 1)

**Used as:** Specific nodes carry aspects not shared by their type — for example, `cli/io/atomic-write` carries `atomic-write-contract` only at the node level, not as a type default.

**Earn-rate: high.** Node-level aspects handle exceptions to type defaults and one-off requirements on specific components.

**Recommendation:** Keep node-level aspects to a minimum. If three or more nodes of the same type share a node-level aspect, move it to the type default.

---

### `implies:` chains

**Used as:** Three chains: `cli-command-contract` → `[command-exit-codes, diagnostic-logging]`; `deterministic` → `[no-nondeterminism-direct]`; `top-level-error-handler` → `[command-exit-codes]`. Implied aspects propagate automatically — no duplication in node or architecture defaults.

**Earn-rate: medium.** The `deterministic` → `no-nondeterminism-direct` chain is the best example: every node that must be deterministic also must not use `Math.random()` or `Date.now()` directly. Declaring this once in the implies chain beats repeating it across 14 engine nodes.

**Recommendation:** Use `implies:` when one aspect logically entails another with no exceptions. Keep chains short — depth > 3 is a code smell indicating the aspect boundaries need rethinking.

> **Terminology note:** Implied aspects are sometimes called "companions" informally in the context of an implies bundle. This is unrelated to **companion files** (`companion.mjs`) — an optional hook on an LLM aspect that resolves per-unit files for the reviewer prompt. When you see the word "companion" in this codebase, check the context: in `implies:` + `status_inherit:` prose it refers to an implied sibling aspect; in the reviewer and aspects docs it refers to the `companion.mjs` hook.

---

### `status:` — three-level aspect lifecycle

**Used as:** New aspects are introduced at `status: advisory` so the reviewer
runs across the whole graph and surfaces refusals as warnings — without
blocking CI. Once the warnings stabilize and we have confidence the rule
fires only on real issues, the aspect is promoted to `status: enforced`.
Aspects still being authored (rule text incomplete, edge cases unclear)
sit at `status: draft` — they produce no expected pairs, so the reviewer
never runs and nothing is recorded in the lock.

```yaml
# .yggdrasil/aspects/audit-logging/yg-aspect.yaml
name: Audit Logging
description: "Every mutation emits an audit event"
status: advisory             # gathering signal; refusals are warnings
reviewer:
  type: llm
```

```yaml
# .yggdrasil/aspects/diagnostic-logging/yg-aspect.yaml
status: enforced             # vetted; refusals block CI

implies:
  - id: correlation-tracking
    status_inherit: own-default   # keep implied sibling at its own default
```

**Earn-rate: high.** Status removes the all-or-nothing rollout problem: a
new aspect would otherwise either block CI on day one or have to be
suppressed everywhere until the codebase caught up. Advisory aspects
give measurement before enforcement; draft keeps work-in-progress
rules out of the reviewer entirely.

**Recommendation:** Author every new aspect at `status: advisory` for
at least one development cycle. Promote to `enforced` only after the
warning surface is clean or knowingly accepted. Use `draft` while
iterating on the rule text — zero cost, zero noise. The `strictest`
default on `status_inherit` propagates enforcement across implies
bundles; use `own-default` only when an implied aspect should not
inherit its implier's level.

---

### `when:` on aspect definitions

**Used as:** Six aspects carry `when:` filters that limit which nodes the aspect checks: `silent-missing-files` fires only on `parser-adapter`, `persistence-adapter`, and `engine` nodes; `atomic-write-contract` fires only on `persistence-adapter`; `test-deterministic` fires only on `test-suite` nodes.

**Earn-rate: high.** Without these filters, attaching an aspect to a flow or type default would fire the reviewer on every node in the graph. Filters eliminate false positives without suppression markers.

**Recommendation:** Add a `when:` filter to every aspect that has a natural home type. The filter is evaluated deterministically at zero cost and eliminates accidental over-application. Start with `node_type:`.

---

### `when: descendants:`

**Used as:** Not currently used in this repo. `descendants:` is a `when:` grammar feature that filters on a node's **hierarchical** descendants — its child nodes in the model tree — **not** the transitive call graph.

**Earn-rate: situational.** Because it walks the model hierarchy and not the call graph, it does not express "any node whose call chain eventually reaches X". To enforce a property along a **call chain** — e.g. every node that leads to an LLM provider must redact provider data before logging it — attach the aspect explicitly to the chain nodes, or use ports + `consumes` (channel 6) to carry the requirement across the specific boundary that matters.

**Recommendation:** Reach for `descendants:` only when the property genuinely follows the parent/child model hierarchy (e.g. "every child node of this subsystem inherits this rule"). It is the most complex filter in the grammar; do not use it to approximate call-chain propagation, which it cannot see — use explicit attachment or a port instead.

---

### Ports + `consumes:` (channel 6)

**Used as:** `cli/io/atomic-write` declares a `write-atomic` port with `atomic-write-contract`. `cli/io/stores` declares `consumes: [write-atomic]` on its `calls` relation, pulling the contract into the consumer's effective aspects.

**Earn-rate: medium.** The port closed a real gap: persistence-adapters could route raw `fs.writeFile` through a helper module and evade the atomic-write requirement. Channel 6 makes the aspect enforceable on the consumer's own code.

**Recommendation:** Declare ports sparingly — only when a critical aspect must be verifiable on the consumer's own source files, not just the target's. A bare `calls` relation is sufficient when you only need to document the dependency. Three questions to ask before creating a port: (1) Is there an aspect that must hold on the consumer? (2) Could the consumer evade the aspect without the port? (3) Are there multiple consumers you would otherwise have to annotate individually?

---

### Flow-level aspects (channel 5)

**Used as:** Nine flows carry aspects. `validate` flow applies `deterministic` and `what-why-next` to its three participant nodes. `verification` flow applies `provider-redaction` and `what-why-next`. Flow-level aspects propagate to all participant nodes automatically.

**Earn-rate: high.** Flows are the right place for cross-cutting process requirements. The `what-why-next` aspect was attached to eight flows covering 30+ nodes — a single flow-level declaration instead of 30 node-level ones.

**Recommendation:** Think of flows as the "cross-cutting concern" layer. If an aspect should apply to every node that participates in a named business process (authentication, payment, approval), put it on the flow. If an aspect applies only to a specific code layer (engine, formatter), use a type default instead.

---

### `enforce: strict` — features deliberately not used

The following features exist in the schema but were not exercised because no genuine use case arose. We document them here so adopters can calibrate expectations:

| Feature | Status | Why not used |
|---|---|---|
| `implies:` object form (conditional gate) | Deferred | No implies chain needed a conditional filter |
| `when: has_mapping:` | Deferred | No aspect needs file-mapping path filter |
| `when: has_port:` | Deferred | Only one port; no aspect needs port-existence predicate |
| `when: target:` (exact node path) | Deferred | No aspect needs to pin to one specific node |
| `when: consumes_port:` | Deferred | Single consumer set; predicate not needed |
| Multi-port `consumes:` | Deferred | Only one port in catalog |
| Paired `emits` / `listens` | Deferred | No event bus in the codebase |
| `extends` / `implements` relations | Deferred | No inheritance hierarchy in TypeScript code |

Deferred does not mean unsupported — these features are tested and documented. They simply had no real use case in this particular dogfood project.

---

## Summary Verdict

| Tier | Features |
|---|---|
| **Use from day one** | `path:` when, combinators (`all_of`/`not`), `parents:`, `log_required`, type-level `aspects:`, `when:` on aspects |
| **Introduce when you have 5+ nodes** | `enforce: strict`, node-level aspects, `implies:`, flow-level aspects |
| **Introduce when a specific problem arises** | `content:` when, ports + `consumes:`, `when: descendants:` |
| **Defer until the schema demands it** | Event relations, `extends`/`implements`, multi-port, conditional implies |

The biggest ROI in our dogfood came from three things: type-level aspect defaults (one YAML line covers all current and future nodes of a type), flow-level aspects (one YAML block covers all participants in a business process), and `enforce: strict` (zero uncovered files at merge time). Everything else is additive.
