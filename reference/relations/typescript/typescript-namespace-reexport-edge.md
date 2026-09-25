---
id: typescript-namespace-reexport-edge
language: typescript
category: import
expectation: edge
cites: "TS Modules Reference — `export * as ns from` (TS 3.8+) re-exports the module as a named namespace; research C3"
---

## Rule

A namespace re-export `export * as ns from './ns'` re-exports the module as a named namespace (a `namespace_export` node) and gives an edge. Its type-only twin `export type * as ns from` gives the same edge (typescript-export-type-star-reexport-edge).

## Files

```ts path=r/ns/value.ts
export const a = 1;
```

```ts path=r/app/use.ts
export * as ns from '../ns/value';
```

## Expect

- r/app/use.ts:1 -> node:ns      # `export * as ns from '../ns/value'` resolves to r/ns/value.ts (node ns)

## Why

The value namespace re-export is a dependency on the module it republishes.
