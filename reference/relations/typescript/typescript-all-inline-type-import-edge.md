---
id: typescript-all-inline-type-import-edge
language: typescript
category: import
expectation: edge
cites: "TS 4.5 inline type modifiers (every specifier `type`-prefixed); Yggdrasil type-only rule"
---

## Rule

An all-inline-type named import `import { type A, type B } from './t'` carries an inline `type` modifier on every specifier and binds no default or namespace. It is the inline spelling of a whole-statement `import type` and gives the same edge. A type-only reference is a dependency like a value import: the importing file compiles only against the module it names, so changing or removing that module breaks it. Every spelling of a type-only reference therefore gives an edge (see typescript-import-type-whole-statement-edge for the rule).

## Files

```ts path=r/t/types.ts
export interface A {}
export interface B {}
```

```ts path=r/app/use.ts
import { type A, type B } from '../t/types';
const a: A = {} as A;
const b: B = {} as B;
```

## Expect

- r/app/use.ts:1 -> node:t      # every specifier inline `type` → still a dependency → edge to node:t
