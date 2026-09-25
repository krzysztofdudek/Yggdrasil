---
id: javascript-jsdoc-import-silence
language: javascript
category: usage-site
expectation: silence
cites: "TS checkJs — JSDoc `@type {import('x').T}` lives in a comment"
---

## Rule

A JSDoc import type (`/** @param {import('../b/types').T} t */`) is read only by the TypeScript checker under `checkJs`. It sits in a comment, which the extractor never parses, so it gives no edge. This is a limit of what is read, not a policy: under the type-only rule (typescript-import-type-whole-statement-edge) a JSDoc import type is a dependency like `import type` in TypeScript, but comment text is not analysed.

## Files

```js path=r/b/types.js
export {};
```

```js path=r/app/use.js
/** @param {import('../b/types').T} t */
export function f(t) { return t; }
```

## Expect

- silence      # comment text is not parsed (a detection limit, not the type-only rule)
