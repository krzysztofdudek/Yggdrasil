---
id: typescript-mixed-inline-type-import-edge
language: typescript
category: import
expectation: edge
cites: "TS 4.5 inline type modifiers (a mixed clause); research B4"
---

## Rule

A mixed inline-type import `import { type A, b } from './m'` names the type `A` and the value `b` of the same module. It is one dependency on `./m` and gives one edge; the inline `type` on `A` changes nothing about it. Since 6.1.0 every type-only spelling gives an edge too (typescript-import-type-whole-statement-edge), so no clause shape silences an import; this case pins that it still gives exactly one.

## Files

```ts path=r/m/value.ts
export interface A {}
export const b = 1;
```

```ts path=r/app/use.ts
import { type A, b } from '../m/value';
const a: A = {} as A;
console.log(b);
```

## Expect

- r/app/use.ts:1 -> node:m      # `import { type A, b }` → one edge to r/m/value.ts (node m)

## Why

One statement, one module, one edge, whatever mix of value and type bindings it carries.
