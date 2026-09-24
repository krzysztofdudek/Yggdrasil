---
id: typescript-explicit-ts-extension-edge
language: typescript
category: import
expectation: edge
cites: "TS 5.0 allowImportingTsExtensions / Deno / Bun explicit `.ts` specifiers"
---

## Rule

An explicit `.ts` extension (`import { x } from './m.ts'`) is used as-is.

## Files

```ts path=r/b/value.ts
export const x = 1;
```

```ts path=r/app/use.ts
import { x } from '../b/value.ts';
console.log(x);
```

## Expect

- r/app/use.ts:1 -> node:b      # explicit `.ts` resolves literally
