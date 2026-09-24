---
id: typescript-tsconfig-paths-edge
language: typescript
category: import
expectation: edge
cites: "TS Module Resolution — `paths` (exact key, else longest-prefix `*` pattern; substitutions resolve from `baseUrl`, else from the tsconfig's directory)"
---

## Rule

A tsconfig `paths` alias (`@/*` → `./src/*`, the Next.js default) is resolved the way the compiler resolves it: the nearest tsconfig.json of the importing file, its `extends` chain applied, the exact key or else the longest-prefix wildcard pattern, each substitution probed like a relative path. Exactly one substitution naming a file gives the edge.

## Files

```json path=tsconfig.json
{
  // comments and trailing commas are tsconfig dialect
  "compilerOptions": { "paths": { "@/*": ["./src/*"], }, },
}
```

```ts path=src/b/value.ts
export const X = 1;
```

```ts path=src/a/use.ts
import { X } from '@/b/value';
console.log(X);
```

## Expect

- src/a/use.ts:1 -> node:b      # `@/b/value` → src/b/value.ts through `paths`
