---
id: typescript-inline-type-runtime-default-edge
language: typescript
category: import
expectation: edge
cites: "TS 4.5 inline type modifiers (a default binding next to inline `type` specifiers); research B5"
---

## Rule

An import `import def, { type A } from './m'` binds the default `def` at runtime and names the type `A`. Both halves depend on `./m`, and the statement gives one edge. Since 6.1.0 every type-only spelling gives an edge too (typescript-import-type-whole-statement-edge), so no clause shape silences an import; this case pins that it still gives exactly one.

## Files

```ts path=r/m/value.ts
export default function def() {}
export interface A {}
```

```ts path=r/app/use.ts
import def, { type A } from '../m/value';
def();
const a: A = {} as A;
```

## Expect

- r/app/use.ts:1 -> node:m      # `import def, { type A }` → one edge to r/m/value.ts (node m)

## Why

One statement, one module, one edge, whatever mix of value and type bindings it carries.
