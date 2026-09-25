---
id: typescript-import-type-paths-multi-target-silence
language: typescript
category: trap
expectation: silence
cites: "TS Module Resolution — `paths` fallback substitutions; Yggdrasil zero-false-positive rule"
---

## Rule

A type-only import is resolved by the same resolver as a value import, so the ambiguity rules hold for it unchanged: a `paths` pattern with two substitutions that both name an existing file stays silent (typescript-tsconfig-paths-multi-target-silence). Making type-only imports edges adds recall, never a guessed target.

## Files

```json path=tsconfig.json
{ "compilerOptions": { "paths": { "@lib/*": ["./libs/one/*", "./libs/two/*"] } } }
```

```ts path=libs/one/types.ts
export interface U { n: number }
```

```ts path=libs/two/types.ts
export interface U { n: string }
```

```ts path=src/app/use.ts
import type { U } from '@lib/types';
export const f = (u: U) => u;
```

## Expect

- silence      # two substitutions name two different files → ambiguous → no edge, type-only or not
