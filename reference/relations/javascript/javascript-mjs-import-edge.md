---
id: javascript-mjs-import-edge
language: javascript
category: import
expectation: edge
cites: "Node ES modules — static import in a `.mjs` file"
---

## Rule

A static import in an `.mjs` file with an explicit `.mjs` specifier resolves to that file.

## Files

```js path=r/b/value.mjs
export const x = 1;
```

```js path=r/app/use.mjs
import { x } from '../b/value.mjs';
console.log(x);
```

## Expect

- r/app/use.mjs:1 -> node:b      # ESM import in .mjs
