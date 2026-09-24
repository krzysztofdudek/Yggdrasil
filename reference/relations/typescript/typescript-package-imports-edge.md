---
id: typescript-package-imports-edge
language: typescript
category: import
expectation: edge
cites: "Node package `imports` (`#subpath` pattern entries)"
---

## Rule

A `#`-specifier (`#internal/x`) resolves through the `imports` map of the importing file's nearest package.json: the exact key, else the longest `*` pattern, with a relative target resolved inside that package.

## Files

```json path=package.json
{ "name": "app", "imports": { "#internal/*": "./r/internal/*.ts" } }
```

```ts path=r/internal/x.ts
export const x = 1;
```

```ts path=r/app/use.ts
import { x } from '#internal/x';
console.log(x);
```

## Expect

- r/app/use.ts:1 -> node:internal      # `#internal/*` → r/internal/x.ts
