---
id: typescript-mixed-inline-type-reexport-edge
language: typescript
category: import
expectation: edge
cites: "TS 4.5 inline type modifiers on re-exports (a mixed clause); research C7"
---

## Rule

A mixed inline-type re-export `export { type A, b } from './m'` republishes the type `A` and the value `b` of `./m`. It is one dependency on `./m` and gives one edge. Since 6.1.0 every type-only spelling gives an edge too (typescript-import-type-whole-statement-edge), so no clause shape silences an import; this case pins that it still gives exactly one.

## Files

```ts path=r/m/value.ts
export interface A {}
export const b = 1;
```

```ts path=r/app/use.ts
export { type A, b } from '../m/value';
```

## Expect

- r/app/use.ts:1 -> node:m      # `export { type A, b }` → one edge to r/m/value.ts (node m)

## Why

One statement, one module, one edge, whatever mix of value and type specifiers it carries.
