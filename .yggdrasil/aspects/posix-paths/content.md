# POSIX Paths

All internal path handling normalizes to POSIX format for cross-platform consistency.

## Rules

- Backslash `\` is always replaced with forward slash `/` before any path comparison or storage.
- Trailing slashes are always stripped.
- Input paths are trimmed of whitespace before processing.
- Path comparisons use the normalized form, never raw input.

## Implementation pattern

```typescript
path.replace(/\\/g, '/').replace(/\/+$/, '')
```

This appears in: `utils/paths.ts` (normalizeProjectRelativePath, normalizeMappingPaths), `cli/owner.ts` (normalizeForMatch), `core/validator.ts` (normalizePathForCompare), `core/drift-detector.ts`, and all command handlers processing `--node` options.
