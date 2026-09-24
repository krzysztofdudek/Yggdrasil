---
id: typescript-export-type-star-reexport-silence
language: typescript
category: trap
expectation: silence
cites: "TS 5.0 type modifiers on `export *` (`export type * [as ns] from` is type-only, erased; the `type` marker is a token in the shipped grammar, ERROR-wrapped in 0.23.2); research C8 (SEALED genuine FP)"
---

## Rule

The SEALED genuine false-positive. `export type * from './t'` (and the aliased `export type * as T from './t'`) is a TYPE-ONLY star/namespace re-export valid since TypeScript 5.0; it erases at compile time and carries no runtime dependency. The grammar shipped since 6.1.0 parses the leading `type` as a token of the statement; tree-sitter-typescript 0.23.2 wrapped it in an `ERROR` node before the `*`. The guard accepts both: a direct `type` token, or an `ERROR` node whose text is EXACTLY `type` (matched verbatim so an unrelated parse error never trips it). Either way the statement is silenced — before the guard this emitted a spurious runtime edge.

## Files

```ts path=r/t/types.ts
export interface A {}
```

```ts path=r/app/use.ts
export type * from '../t/types';
```

## Expect

- silence      # `export type *` (ERROR-wrapped `type` marker) erases at compile time → no runtime edge to node:t

## Why

The grammar's ERROR-wrapped `type` keyword once slipped past the type guard and emitted
a runtime edge over a compile-time-only re-export; recognizing it verbatim seals that
false positive while never tripping on an unrelated parse error.
