---
id: typescript-type-argument-import-type-edge
language: typescript
category: usage-site
expectation: edge
cites: "TS 2.9 import types in a type argument; Yggdrasil type-only rule"
---

## Rule

An import type passed as a type argument (`useStore<import('./m').State>()`, `new Map<string, import('./m').Item>()`) instantiates a generic with a type of `./m`. The call's value side names nothing, but the type argument does, so it gives an edge at its own line. A type-only reference is a dependency like a value import: the importing file compiles only against the module it names, so changing or removing that module breaks it. Every spelling of a type-only reference therefore gives an edge (see typescript-import-type-whole-statement-edge for the rule).

## Files

```ts path=r/b/types.ts
export interface State { n: number }
export interface Item { id: string }
```

```ts path=r/app/use.ts
declare function useStore<S>(): S;
export const s = useStore<import('../b/types').State>();
export const m = new Map<string, import('../b/types').Item>();
```

## Expect

- r/app/use.ts:2 -> node:b      # type argument of a call
- r/app/use.ts:3 -> node:b      # type argument of a constructor
