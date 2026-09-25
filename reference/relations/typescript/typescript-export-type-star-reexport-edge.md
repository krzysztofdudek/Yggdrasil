---
id: typescript-export-type-star-reexport-edge
language: typescript
category: import
expectation: edge
cites: "TS 5.0 type modifiers on `export *` (`export type * [as ns] from`); the `type` marker is a token in the shipped grammar, ERROR-wrapped in 0.23.2"
---

## Rule

`export type * from './t'` (and `export type * as T from './t'`) republishes every type of `./t`, valid since TypeScript 5.0. It gives an edge like a value star re-export. The grammar shipped since 6.1.0 parses the leading `type` as a token of the statement (tree-sitter-typescript 0.23.2 wrapped it in an `ERROR` node); either way the statement's `source` is read. A type-only reference is a dependency like a value import: the importing file compiles only against the module it names, so changing or removing that module breaks it. Every spelling of a type-only reference therefore gives an edge (see typescript-import-type-whole-statement-edge for the rule).

## Files

```ts path=r/t/types.ts
export interface A {}
```

```ts path=r/app/use.ts
export type * from '../t/types';
```

## Expect

- r/app/use.ts:1 -> node:t      # `export type *` re-exports the types of node:t → edge
