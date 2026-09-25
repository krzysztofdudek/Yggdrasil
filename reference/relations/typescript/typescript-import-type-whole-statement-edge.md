---
id: typescript-import-type-whole-statement-edge
language: typescript
category: import
expectation: edge
cites: "TS 3.8 `import type` (a type-only import); Yggdrasil type-only rule (6.1.0: a type-only import is a dependency)"
---

## Rule

A whole-statement `import type { T } from './t'` imports only a type. TypeScript erases it from the emitted JavaScript, but the importing file still compiles only against `./t`: rename `T`, remove it or change its shape and the importer breaks. A relation edge records that one node's code depends on another's, not that a module is loaded at runtime, so a type-only import gives its edge exactly like a value import, and a missing relation is a `relation-undeclared-dependency` like any other. The same rule covers every spelling: `import type * as`, an all-inline `import { type A }`, `export type { … } from`, `export type * from`, `import type X = require(…)`, `typeof import('…')`, an annotation `import('…').T`, the type side of `as`/`satisfies`, a type argument and a module augmentation. Before 6.1.0 the statement forms were silent.

## Files

```ts path=r/t/types.ts
export interface T {}
```

```ts path=r/app/use.ts
import type { T } from '../t/types';
const x: T = {} as T;
```

## Expect

- r/app/use.ts:1 -> node:t      # `import type { T }` is a type-only dependency → edge to node:t

## Why

A type is part of a module's contract. A node that consumes another node's types is coupled to it, and an architecture that forbids that coupling must see it.
