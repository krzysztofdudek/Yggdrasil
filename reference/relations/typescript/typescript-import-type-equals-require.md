---
id: typescript-import-type-equals-require
language: typescript
category: import
expectation: edge
cites: "TS 5.0 `import type X = require()` (a type-only import-equals); Yggdrasil type-only rule"
---

## Rule

`import type B = require('./b')` is the CommonJS spelling of a type-only import. It gives the same edge as a plain `import B = require('./b')` (typescript-import-equals-require-edge). Before 6.1.0 it emitted an edge while `import type` did not; both now give one. A type-only reference is a dependency like a value import: the importing file compiles only against the module it names, so changing or removing that module breaks it. Every spelling of a type-only reference therefore gives an edge (see typescript-import-type-whole-statement-edge for the rule).

## Files

```ts path=r/b/value.cts
export = { go() {} };
```

```ts path=r/app/use.cts
import type B = require('../b/value.cjs');
export const f = (b: B) => b;
```

## Expect

- r/app/use.cts:1 -> node:b      # type-only import-equals → edge to node:b
