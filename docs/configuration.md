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
- **Quality thresholds** — When to warn about structural issues
- **Parallel** — Concurrency for batch approve operations
- **Reviewer** — Semantic verification provider and settings

Nodes contain only `yg-node.yaml` — no `.md` artifact files. Enforceable rules are
defined as aspects.

---

## Quality config

| Field | Default | Description |
|-------|---------|-------------|
| `max_direct_relations` | 10 | Max relations before high fan-out warning |

---

## Example

```yaml
name: my-repo

quality:
  max_direct_relations: 10

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
  # Optional fields per type: aspects, parents, relations
  # See docs/concept/graph.md for the full architecture file format.
```

---

## Reviewer config

Optional. Enables semantic verification during `yg approve` — aspect verification.
The `reviewer:` section in `yg-config.yaml` uses a nested provider structure.

```yaml
reviewer:
  active: ollama                  # required when multiple providers listed
  verify_aspects: true            # run aspect verification — default true
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

General keys (`active`, `verify_aspects`, `consensus`) sit at the `reviewer:` level.
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

- `yg-node.yaml` is a reserved filename in model directories.
