---
title: Configuration
---

Config file: `.yggdrasil/yg-config.yaml`

`yg init` creates this file and configures the reviewer interactively.

---

## Schema

### Required

- **reviewer** — Reviewer provider config (see [Reviewer config](#reviewer-config) below).
  Configured during `yg init`.

### Optional

- **version** — CLI version that last wrote this config. Set automatically by `yg init`.
- **quality** — Quality thresholds
- **parallel** — Concurrency limit for batch approve (positive integer, default: 1). Higher
  values run multiple `approveNode()` calls concurrently during `--aspect`/`--flow`/multi-node
  approve.

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

| Field                  | Default | Description                               |
|------------------------|---------|-------------------------------------------|
| `max_direct_relations` | 10      | Max relations before high fan-out warning |

---

## Example

```yaml
quality:
  max_direct_relations: 10

parallel: 1
debug: true                        # optional — append all CLI output to .yggdrasil/.debug.log

reviewer:
  anthropic:
    model: claude-sonnet-4-6
```

Node types go in `yg-architecture.yaml`:

```yaml
node_types:
  module:
    description: "Business logic unit with clear domain responsibility"
  service:
    description: "Component providing functionality to other nodes"
    aspects: [requires-audit]
    relations:
      calls: [service, library]
      uses: [library]
  library:
    description: "Shared utility code with no domain knowledge"
  infrastructure:
    description: "Guards, middleware, interceptors"
  data:
    description: "Database layer, persistence, and data access"
```

---

## Reviewer config

The reviewer verifies aspects against source code during `yg approve`.
Configured during `yg init` or manually in the `reviewer:` section of `yg-config.yaml`.

General keys (`active`, `consensus`) sit at the `reviewer:` level.
Provider-specific keys sit under the provider name.

```yaml
reviewer:
  active: anthropic               # required when multiple providers listed
  consensus: 1                    # positive odd integer >= 1
```

### API providers

API providers make HTTP calls to an LLM endpoint. They accept `model`, `endpoint`,
`temperature`, and `api_key`.

#### Anthropic

```yaml
reviewer:
  anthropic:
    model: claude-sonnet-4-6
    temperature: 0
```

#### OpenAI

```yaml
reviewer:
  openai:
    model: gpt-4o
    temperature: 0
```

#### Google

```yaml
reviewer:
  google:
    model: gemini-2.5-flash
    temperature: 0
```

#### OpenAI-compatible

Any endpoint that implements the OpenAI API.

```yaml
reviewer:
  openai-compatible:
    model: your-model
    endpoint: https://your-endpoint.com/v1
    temperature: 0
```

#### Ollama (local)

```yaml
reviewer:
  ollama:
    model: qwen3:8b
    endpoint: http://localhost:11434    # default
    temperature: 0
    max_tokens: auto                   # auto = query model for context window size
    context_length_field: ""           # ollama model_info key override
```

### CLI agent providers

CLI providers delegate verification to an agent CLI installed on your machine.
They accept `model` and `timeout` (in milliseconds).

#### Claude Code

```yaml
reviewer:
  claude-code:
    model: sonnet                      # haiku, sonnet, or opus
```

#### Codex

```yaml
reviewer:
  codex:
    model: o4-mini
```

#### Gemini CLI

```yaml
reviewer:
  gemini-cli:
    model: gemini-2.5-flash
```

### API keys and secrets

Credentials go in `.yggdrasil/yg-secrets.yaml` (gitignored, not committed):

```yaml
reviewer:
  anthropic:
    api_key: sk-ant-...
  openai:
    api_key: sk-...
  google:
    api_key: AI...
```

API providers also check environment variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_API_KEY`. If the env var is set, you don't need `yg-secrets.yaml`.

---

## Notes

- `yg-node.yaml` is a reserved filename in model directories.
