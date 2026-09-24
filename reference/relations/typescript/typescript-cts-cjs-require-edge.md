---
id: typescript-cts-cjs-require-edge
language: typescript
category: import
expectation: edge
cites: "TS NodeNext — `.cjs` specifier names the `.cts` source"
---

## Rule

A `require('./m.cjs')` in a `.cts` file names the `.cts` source; the resolver rewrites `.cjs` to `.cts` before probing `.cjs` itself.

## Files

```ts path=r/b/value.cts
module.exports = { x: 1 };
```

```ts path=r/app/use.cts
const b = require('../b/value.cjs');
console.log(b.x);
```

## Expect

- r/app/use.cts:1 -> node:b      # `.cjs` → `.cts` rewrite
