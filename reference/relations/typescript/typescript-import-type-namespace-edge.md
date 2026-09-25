---
id: typescript-import-type-namespace-edge
language: typescript
category: import
expectation: edge
cites: "TS 3.8 (`import type * as T` is a whole-statement type import); Yggdrasil type-only rule"
---

## Rule

A whole-statement namespace type import `import type * as T from './t'` names the module the same way the named form does, so it gives the same edge. A type-only reference is a dependency like a value import: the importing file compiles only against the module it names, so changing or removing that module breaks it. Every spelling of a type-only reference therefore gives an edge (see typescript-import-type-whole-statement-edge for the rule).

## Files

```ts path=r/t/types.ts
export interface T {}
```

```ts path=r/app/use.ts
import type * as T from '../t/types';
const x: T.T = {} as T.T;
```

## Expect

- r/app/use.ts:1 -> node:t      # `import type * as T` → edge to node:t
