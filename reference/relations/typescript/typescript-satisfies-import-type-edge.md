---
id: typescript-satisfies-import-type-edge
language: typescript
category: usage-site
expectation: edge
cites: "TS 4.9 `satisfies`; TS 2.9 import types; Yggdrasil type-only rule"
---

## Rule

The type side of `satisfies` (`cfg satisfies import('./m').Config`) checks a value against a type of `./m`, so the file compiles only against `./m` and gives an edge at that line. The operand on the value side is untouched: a plain object literal adds nothing. A type-only reference is a dependency like a value import: the importing file compiles only against the module it names, so changing or removing that module breaks it. Every spelling of a type-only reference therefore gives an edge (see typescript-import-type-whole-statement-edge for the rule).

## Files

```ts path=r/b/types.ts
export interface Config { port: number }
```

```ts path=r/app/use.ts
export const cfg = { port: 1 } satisfies import('../b/types').Config;
```

## Expect

- r/app/use.ts:1 -> node:b      # the type side of `satisfies` names node:b
