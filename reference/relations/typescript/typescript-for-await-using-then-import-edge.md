---
id: typescript-for-await-using-then-import-edge
language: typescript
category: trap
expectation: edge
cites: "TS 5.2 `await using`; tree-sitter-typescript 0.23.2 swallowed the statements after `for (await using …)` into an ERROR region (fixed in the grammar Yggdrasil 6.1.0 ships)"
---

## Rule

tree-sitter-typescript 0.23.2 did not parse `for (await using x of xs)`: the ERROR region swallowed the statements after it, including a static import, and the import lost its edge. The grammar shipped since 6.1.0 parses the loop, and the extractor also rescans every line an ERROR node touches for a line-anchored import or re-export. This case pins the outcome either way: the import after the loop keeps its edge.

## Files

```ts path=r/b/value.ts
export const B = 1;
```

```ts path=r/app/use.ts
for (await using x of xs) {}
import { B } from '../b/value';
console.log(B);
```

## Expect

- r/app/use.ts:2 -> node:b      # recovered from the ERROR region
