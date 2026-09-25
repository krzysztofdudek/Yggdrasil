---
id: typescript-import-type-declaration-file-edge
language: typescript
category: import
expectation: edge
cites: "TS Module Resolution — declaration files (`.d.ts` is probed after `.ts`/`.tsx`; `./x.js` finds `./x.d.ts`); Yggdrasil type-only rule"
---

## Rule

A type-only import commonly names a declaration file. The resolver probes a declaration file the way the compiler does: an extensionless `./types` tries `types.ts`, `types.tsx`, then `types.d.ts`; a `./api.js` specifier tries `api.ts`, `api.tsx`, then `api.d.ts` (`.mjs` → `.d.mts`, `.cjs` → `.d.cts`); a directory's `index.d.ts` follows its `index.ts`/`index.tsx`. A type-only reference is a dependency like a value import: the importing file compiles only against the module it names, so changing or removing that module breaks it. Every spelling of a type-only reference therefore gives an edge (see typescript-import-type-whole-statement-edge for the rule).

## Files

```ts path=r/t/types.d.ts
export interface T { n: number }
```

```ts path=r/u/api.d.ts
export interface Api { go(): void }
```

```ts path=r/app/use.ts
import type { T } from '../t/types';
import type { Api } from '../u/api.js';
export const f = (t: T, a: Api) => [t, a];
```

## Expect

- r/app/use.ts:1 -> node:t      # extensionless → types.d.ts
- r/app/use.ts:2 -> node:u      # `.js` specifier → api.d.ts
