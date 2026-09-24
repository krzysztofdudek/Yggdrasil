---
id: javascript-cjs-require-edge
language: javascript
category: import
expectation: edge
cites: "Node CommonJS — `require()` in a `.cjs` file"
---

## Rule

A CommonJS `.cjs` file's `require('./m.cjs')` resolves with the same path rules as TypeScript (the `.cjs` target is probed after its `.cts` source).

## Files

```js path=r/b/value.cjs
module.exports = { x: 1 };
```

```js path=r/app/use.cjs
const b = require('../b/value.cjs');
console.log(b.x);
```

## Expect

- r/app/use.cjs:1 -> node:b      # CommonJS require
