# Silent Missing Files

Components tagged with this aspect treat missing optional files/directories as valid empty state, not errors.

## Pattern

```typescript
try {
  // read file or directory
} catch {
  return []; // or return {}
}
```

## Applies to

- **Graph loader:** `aspects/`, `flows/`, `schemas/` directories may not exist. Return empty arrays.
- **Drift state store:** `.drift-state` file may not exist. Return empty object `{}`.
- **Journal store:** `.journal.yaml` file may not exist. Return empty array `[]`.

## Rationale

A fresh or partially initialized `.yggdrasil/` directory is valid. The absence of optional directories signals "nothing configured yet", not corruption. This enables incremental adoption -- users can start with just `config.yaml` and `model/`.
