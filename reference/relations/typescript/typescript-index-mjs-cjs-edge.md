---
id: typescript-index-mjs-cjs-edge
language: typescript
category: import
expectation: edge
cites: "Node/TS directory index — `index.mjs` / `index.cjs`"
---

## Rule

A directory import whose index is an `.mjs` or `.cjs` file resolves to it; the index probe covers `index.ts|tsx|js|jsx|mjs|cjs`.

## Files

```js path=r/b/index.mjs
export const x = 1;
```

```ts path=r/app/use.ts
import { x } from '../b';
console.log(x);
```

## Expect

- r/app/use.ts:1 -> node:b      # directory index `index.mjs`
