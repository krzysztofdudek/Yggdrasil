---
id: typescript-typeof-import-type-query
language: typescript
category: usage-site
expectation: edge
cites: "TS 2.9 import types (`typeof import('x')` is a type query); Yggdrasil type-only rule"
---

## Rule

A type query over an import type (`typeof import('./m')`, the vitest `importOriginal<typeof import('./m')>()` idiom) derives a type from the module's exports, so the file depends on that module: rename an export and the query breaks. It gives an edge in a type alias and in a type argument alike. A type-only reference is a dependency like a value import: the importing file compiles only against the module it names, so changing or removing that module breaks it. Every spelling of a type-only reference therefore gives an edge (see typescript-import-type-whole-statement-edge for the rule).

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

- r/app/use.ts:1 -> node:b      # `typeof import()` in a type alias
- r/app/use.ts:3 -> node:b      # `typeof import()` in a type argument
