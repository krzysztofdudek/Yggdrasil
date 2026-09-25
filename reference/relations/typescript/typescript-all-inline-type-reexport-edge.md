---
id: typescript-all-inline-type-reexport-edge
language: typescript
category: import
expectation: edge
cites: "TS 4.5 inline type modifiers on re-exports; Yggdrasil type-only rule"
---

## Rule

An all-inline-type re-export `export { type A, type B } from './t'` republishes types of `./t` as part of this module's own surface, so this module depends on `./t`. It gives the same edge as a value re-export. A type-only reference is a dependency like a value import: the importing file compiles only against the module it names, so changing or removing that module breaks it. Every spelling of a type-only reference therefore gives an edge (see typescript-import-type-whole-statement-edge for the rule).

## Files

```ts path=r/t/types.ts
export interface A {}
export interface B {}
```

```ts path=r/app/use.ts
export { type A, type B } from '../t/types';
```

## Expect

- r/app/use.ts:1 -> node:t      # all-inline-type re-export → edge to node:t
