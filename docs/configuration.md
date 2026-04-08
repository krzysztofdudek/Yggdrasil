---
title: Configuration
---

Everything here is optional except the fields required by the schema.
Yggdrasil works out of the box with sensible defaults.

Config file: `.yggdrasil/yg-config.yaml`

---

## Schema

### Required fields

- **name** — Project identity (non-empty string)

### Optional fields

- **version** — CLI version that last wrote this config. Set automatically by `yg init` and
  `yg init --upgrade`.
- **quality** — Quality thresholds
- **parallel** — Concurrency limit for batch approve (positive integer, default: 1). Higher
  values run multiple `approveNode()` calls concurrently during `--aspect`/`--flow`/multi-node
  approve.
- **reviewer** — Semantic verification config (see [Reviewer config](#reviewer-config) below)

Node types are defined in the separate **architecture file** (`.yggdrasil/yg-architecture.yaml`),
not in `yg-config.yaml`.

---

## What you can customize

- **Node types** — Defined in `yg-architecture.yaml` (not `yg-config.yaml`). The vocabulary of
  parts your repo uses (e.g. `module`, `service`, `library`), with optional `aspects`, `parents`,
  and `relations` constraints.
- **Quality thresholds** — When to warn about shallow memory or large context
- **Parallel** — Concurrency for batch approve operations
- **Reviewer** — Semantic verification provider and settings

The three standard artifacts (`responsibility.md`, `interface.md`, `internals.md`) are built into the CLI and cannot be configured. `responsibility.md` is always required, `interface.md` is required when a node has consumers, and `internals.md` is always optional.

---

## Quality config

| Field | Default | Description |
|-------|---------|-------------|
| `min_artifact_length` | 50 | Minimum chars for artifact content (shallow warning) |
| `max_direct_relations` | 10 | Max relations before high fan-out warning |
| `context_budget.warning` | 10000 | Token count warning threshold |
| `context_budget.error` | 20000 | Token count error threshold |

---

## Example

```yaml
name: my-repo

quality:
  min_artifact_length: 50
  max_direct_relations: 10
  context_budget:
    warning: 10000
    error: 20000

parallel: 1
debug: true                        # optional — append all CLI output to .yggdrasil/.debug.log
```

Node types go in `yg-architecture.yaml`:

```yaml
node_types:
  module:
    description: "Business logic unit with clear domain responsibility"
  service:
    description: "Component providing functionality to other nodes"
    aspects: [requires-audit]
  library:
    description: "Shared utility code with no domain knowledge"
  # Optional fields per type: quality_profile, parents, relations
  # See docs/concept/graph.md for the full architecture file format.
```

---

## Reviewer config

Optional. Enables semantic verification during `yg approve` — aspect verification (E055)
and optionally artifact review (E056). The `reviewer:` section in `yg-config.yaml` uses
a nested provider structure.

```yaml
reviewer:
  active: ollama                  # required when multiple providers listed
  verify_aspects: true            # run aspect verification (E055) — default true
  verify_artifacts: false         # run artifact review (E056) — default false
  consensus: 1                    # positive odd integer >= 1
  ollama:
    model: "qwen3.5:9b"
    endpoint: "http://localhost:11434"
    temperature: 0
    max_tokens: auto              # auto = query provider, or explicit number
    context_length_field: ""      # ollama model_info key for context window size
  claude-code:
    model: haiku                  # haiku, sonnet, or opus
```

General keys (`active`, `verify_aspects`, `verify_artifacts`, `consensus`) sit at the `reviewer:` level.
Provider-specific keys sit under the provider name (`ollama:`, `claude-code:`).

Credentials and endpoint overrides go in `.yggdrasil/yg-secrets.yaml` (gitignored):

```yaml
reviewer:
  ollama:
    endpoint: http://localhost:11434
    model: qwen3.5:9b
```

---

## Notes

- Artifact name `yg-node.yaml` is reserved.
- `yg-config.yaml: quality.context_budget.error` must be >= `context_budget.warning`.
