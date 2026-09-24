---
id: typescript-mts-mjs-rewrite-edge
language: typescript
category: import
expectation: edge
cites: "TS NodeNext — `.mjs` specifier names the `.mts` source"
---

## Rule

In an ES-module TypeScript file a specifier ending `.mjs` names the `.mts` source it compiles from; the resolver rewrites `.mjs` to `.mts` before probing `.mjs` itself.

## Files

```ts path=r/b/value.mts
export const x = 1;
```

```ts path=r/app/use.mts
import { x } from '../b/value.mjs';
console.log(x);
```

## Expect

- r/app/use.mts:1 -> node:b      # `.mjs` → `.mts` rewrite
