---
id: typescript-typeof-import-type-query
language: typescript
category: usage-site
expectation: silence
cites: "TS 2.9 import types (`typeof import('x')` is a type query, erased); Yggdrasil type-only rule"
---

## Rule

A type query over an import type (`typeof import('./m')`, the vitest `importOriginal<typeof import('./m')>()` idiom) is a type: it loads nothing at runtime. The extractor recognises an `import('…')` call whose ancestors reach a type context (a type query, a type annotation, a type argument, a type alias, the type side of `as`/`satisfies`) before any value boundary and emits nothing. A relation edge records a runtime dependency. TypeScript erases every type-only construct from the emitted JavaScript, so every spelling of a type-only reference is silent, the statement forms (`import type`, `export type`, all-inline `type` clauses; see typescript-import-type-whole-statement-silence) and the type-position forms alike.

## Files

```ts path=r/b/value.ts
export const x = 1;
```

```ts path=r/app/use.ts
type M = typeof import('../b/value');
export const pick = (m: M) => m.x;
export const mocked = vi.fn<() => Promise<typeof import('../b/value')>>();
```

## Expect

- silence      # `typeof import()` in an alias and in a type argument → erased → no edge

## Why

Before 6.1.0 this form emitted an edge while `import type` was silent, so the ubiquitous vitest idiom produced false edges; one rule now covers both.
