---
id: javascript-jsdoc-import-silence
language: javascript
category: usage-site
expectation: silence
cites: "TS checkJs — JSDoc `@type {import('x').T}` lives in a comment"
---

## Rule

A JSDoc import type (`/** @param {import('../b/types').T} t */`) is read only by the TypeScript checker under `checkJs`. It is a type reference, silent under the type-only rule that silences `import type` in TypeScript, and it sits in a comment, which the extractor never parses.

## Files

```js path=r/b/types.js
export {};
```

```js path=r/app/use.js
/** @param {import('../b/types').T} t */
export function f(t) { return t; }
```

## Expect

- silence      # a type reference, and comment text is not parsed
