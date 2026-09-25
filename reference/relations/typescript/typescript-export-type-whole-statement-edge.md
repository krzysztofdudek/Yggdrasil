---
id: typescript-export-type-whole-statement-edge
language: typescript
category: import
expectation: edge
cites: "TS 3.8 `export type { X } from` (a type-only re-export); Yggdrasil type-only rule"
---

## Rule

A whole-statement type re-export `export type { X } from './t'` republishes a type of `./t`: this module's surface is built from it, so it depends on `./t` and gives an edge. A type-only reference is a dependency like a value import: the importing file compiles only against the module it names, so changing or removing that module breaks it. Every spelling of a type-only reference therefore gives an edge (see typescript-import-type-whole-statement-edge for the rule).

## Files

```ts path=r/t/types.ts
export interface X {}
```

```ts path=r/app/use.ts
export type { X } from '../t/types';
```

## Expect

- r/app/use.ts:1 -> node:t      # `export type { X } from` → edge to node:t
