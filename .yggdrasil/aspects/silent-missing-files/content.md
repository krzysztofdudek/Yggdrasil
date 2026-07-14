# Silent Missing Files

Files tagged with this aspect treat missing optional files/directories as valid empty state, not errors.

## Pattern

```typescript
try {
  // read file or directory
} catch {
  return []; // or return {}
}
```

## Scope

A file satisfies this aspect if every optional file or directory the reader it
contains reads uses the pattern above. Each file is evaluated against only the
optional resources it is responsible for; presence of unrelated resources is out
of scope.

Known examples (each enforced on the owning reader, not all of them on one):

- **Graph loader:** `aspects/`, `flows/` directories may not exist. Return empty arrays.
- **Lock store:** the `yg-lock.json` file may not exist. Return an empty lock.
- **Secrets parser:** `yg-secrets.yaml` may not exist. Return `undefined`.

## Rationale

A fresh or partially initialized `.yggdrasil/` directory is valid. The absence of optional directories signals "nothing configured yet", not corruption. This enables incremental adoption -- users can start with just `yg-config.yaml` and `model/`.
