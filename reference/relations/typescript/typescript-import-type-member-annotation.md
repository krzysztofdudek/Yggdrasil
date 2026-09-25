---
id: typescript-import-type-member-annotation
language: typescript
category: usage-site
expectation: edge
cites: "TS 2.9 import types (`import('x').T` in an annotation or an `as` type); Yggdrasil type-only rule"
---

## Rule

An inline import type in an annotation (`let v: import('./m').T`) or on the type side of `as` names the module by a string literal, like a value-position `import('./m')`, and gives an edge at its own line. A type-only reference is a dependency like a value import: the importing file compiles only against the module it names, so changing or removing that module breaks it. Every spelling of a type-only reference therefore gives an edge (see typescript-import-type-whole-statement-edge for the rule).

## Files

```ts path=r/b/types.ts
export interface T { n: number }
```

```ts path=r/c/value.ts
export const c = 1;
```

```ts path=r/app/use.ts
let v: import('../b/types').T | undefined;
const w = {} as import('../b/types').T;
export const load = () => import('../c/value');
export const read = () => [v, w];
```

## Expect

- r/app/use.ts:1 -> node:b      # annotation import type
- r/app/use.ts:2 -> node:b      # the type side of `as`
- r/app/use.ts:3 -> node:c      # the value-position import()
