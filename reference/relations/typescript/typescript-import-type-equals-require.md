---
id: typescript-import-type-equals-require
language: typescript
category: import
expectation: silence
cites: "TS 5.0 `import type X = require()` (a type-only import-equals, erased); Yggdrasil type-only rule"
---

## Rule

`import type B = require('./b')` carries the whole-statement `type` token before the `import_require_clause` and is erased like `import type { … }`. The guard runs before the require-clause branch, so the form no longer slips through as an edge. A plain `import B = require('./b')` still gives one (typescript-import-equals-require-edge). A relation edge records a runtime dependency. TypeScript erases every type-only construct from the emitted JavaScript, so every spelling of a type-only reference is silent, the statement forms (`import type`, `export type`, all-inline `type` clauses; see typescript-import-type-whole-statement-silence) and the type-position forms alike.

## Files

```ts path=r/b/value.cts
export = { go() {} };
```

```ts path=r/app/use.cts
import type B = require('../b/value.cjs');
export const f = (b: B) => b;
```

## Expect

- silence      # type-only import-equals → erased → no edge
