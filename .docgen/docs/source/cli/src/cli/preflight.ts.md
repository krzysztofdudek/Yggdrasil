Below is a comprehensive Markdown documentation draft tailored to the purpose, behavior, and usage of the `preflight` command. It avoids restating obvious language‑level details and instead focuses on what the command *does*, why it exists, and how it behaves at runtime.

---

# `preflight` Command Documentation

## Overview

The `preflight` command provides a consolidated diagnostic report for a Yggdrasil project. It inspects the project graph, evaluates structural and semantic correctness, and highlights potential configuration drift. The command is designed to give developers a single, high‑signal snapshot of project health before running workflows that depend on a consistent model state.

This command is registered on a Commander.js `program` instance via `registerPreflightCommand`.

---

## Purpose

`preflight` exists to answer three questions in one pass:

1. **Has the model drifted?**  
   Detects mismatches between the declared model and its expected state.

2. **What is the current model composition?**  
   Reports counts of nodes, aspects, flows, and mapped paths to help developers understand the scale and completeness of the model.

3. **Is the model valid?**  
   Runs full validation and surfaces errors and warnings with contextual detail.

This unified report is intended to be fast, human‑readable, and suitable for CI pipelines.

---

## Command Usage

```bash
yg preflight [--quick]
```

### Options

| Option      | Description |
|-------------|-------------|
| `--quick`   | Skips drift detection. Useful when drift checks are expensive or when only validation/status is needed. |

---

## Behavior

### 1. Graph Loading

The command loads the project graph from the current working directory. All subsequent diagnostics operate on this in‑memory graph representation.

### 2. Drift Detection

Unless `--quick` is provided, the command runs the drift detector and filters out entries that are already in an `ok` state. Only nodes requiring attention are reported.

Skipping drift detection does not affect validation or status reporting.

### 3. Status Summary

The command reports:

- Total node count  
- Total aspect count  
- Total flow count  
- Total mapped path count (aggregated across all nodes)

If no nodes exist, the command prints a bootstrap hint to guide users toward initializing a model structure.

### 4. Validation

The validator is executed in `"all"` mode, ensuring that every rule category is evaluated. Issues are grouped by severity:

- **Errors** — cause a non‑zero exit code  
- **Warnings** — reported but do not affect exit status  

Each issue is printed with:

- Optional issue code  
- Optional node path  
- Human‑readable message  

### 5. Output Format

The command prints a structured, multi‑section report:

```
=== Preflight Report ===

Drift:      ...
Status:     ...
Validation: ...
```

Sections are always present, though their contents vary based on results and options.

### 6. Exit Codes

| Exit Code | Meaning |
|-----------|---------|
| `0`       | No drift (unless skipped) and no validation errors |
| `1`       | Drift detected (when not skipped) **or** validation errors |
| `1`       | Also used for unexpected runtime errors |

Warnings alone never trigger a non‑zero exit code.

---

## Error Handling

Any unexpected exception results in:

- A message printed to `stderr`
- An exit code of `1`

This ensures predictable behavior in automated environments.

---

## When to Use `preflight`

- Before committing model changes  
- As a CI gate to prevent invalid or drifted models from merging  
- When debugging unexpected behavior in downstream tooling  
- When onboarding to a project and wanting a quick health snapshot  

---

If you'd like, I can also generate a shorter version, a version formatted for a README, or a version tailored for API documentation.