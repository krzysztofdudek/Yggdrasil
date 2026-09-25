---
id: typescript-empty-reexport-edge
language: typescript
category: import
expectation: edge
cites: "TS Modules Reference — re-exports (an empty clause still loads the module); research C4"
---

## Rule

An empty re-export clause `export {} from './empty'` has zero specifiers, and the module is still loaded (its side effects run), so it gives an edge like any re-export with a source. Since 6.1.0 every type-only spelling gives an edge too (typescript-import-type-whole-statement-edge), so no clause shape silences an import; this case pins that it still gives exactly one.

## Files

```ts path=r/empty/value.ts
globalThis.loaded = true;
```

```ts path=r/app/use.ts
export {} from '../empty/value';
```

## Expect

- r/app/use.ts:1 -> node:empty      # `export {} from '../empty/value'` loads the module → edge to node:empty

## Why

An empty re-export still loads the target module, so it is a dependency like any other re-export.
