---
id: typescript-tsx-import-type-args-then-import-edge
language: typescript
category: trap
expectation: edge
cites: "TSX — `import('x').T<U>` in an annotation re-lexed the rest of the line as JSX in tree-sitter-typescript 0.23.2 (upstream PR #365, applied in the grammar Yggdrasil 6.1.0 ships)"
---

## Rule

In `.tsx`, tree-sitter-typescript 0.23.2 read `<U>` after an import type as a JSX element and swallowed the following import into JSX text. The grammar shipped since 6.1.0 (upstream PR #365 applied) parses the annotation, and the ERROR-region rescan would recover the import otherwise. The annotation itself is an import type and stays silent (type-only rule); the import after it keeps its edge.

## Files

```ts path=r/x/types.ts
export interface Box<T> { v: T }
```

```ts path=r/b/value.ts
export const B = 1;
```

```tsx path=r/app/view.tsx
let v: import('../x/types').Box<number>;
import { B } from '../b/value';
export const V = () => <div>{B}</div>;
```

## Expect

- r/app/view.tsx:2 -> node:b      # swallowed import recovered; line 1 (an import type) stays silent
