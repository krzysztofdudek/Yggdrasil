---
id: typescript-import-type-member-annotation
language: typescript
category: usage-site
expectation: silence
cites: "TS 2.9 import types (`import('x').T` in an annotation or an `as` type, erased); Yggdrasil type-only rule"
---

## Rule

An inline import type in an annotation (`let v: import('./m').T`) or on the type side of `as` names a type only and loads nothing. A value-position `import('./m')` on the same line of the same file still gives its edge. A relation edge records a runtime dependency. TypeScript erases every type-only construct from the emitted JavaScript, so every spelling of a type-only reference is silent, the statement forms (`import type`, `export type`, all-inline `type` clauses; see typescript-import-type-whole-statement-silence) and the type-position forms alike.

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

- r/app/use.ts:3 -> node:c      # the value-position import() keeps its edge; lines 1-2 (import types) stay silent
