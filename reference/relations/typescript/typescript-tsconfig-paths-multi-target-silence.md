---
id: typescript-tsconfig-paths-multi-target-silence
language: typescript
category: trap
expectation: silence
cites: "TS Module Resolution — `paths` fallback substitutions; Yggdrasil zero-false-positive rule"
---

## Rule

A `paths` pattern with two substitutions that BOTH name an existing file is treated as ambiguous and silenced. The compiler would take the first, but a layout where the same module exists under two roots is exactly where a guessed edge is most likely wrong about which one the build uses, and a wrong edge is worse than a missed one.

## Files

```json path=tsconfig.json
{ "compilerOptions": { "paths": { "@lib/*": ["./libs/one/*", "./libs/two/*"] } } }
```

```ts path=libs/one/util.ts
export const u = 1;
```

```ts path=libs/two/util.ts
export const u = 2;
```

```ts path=src/app/use.ts
import { u } from '@lib/util';
console.log(u);
```

## Expect

- silence      # two substitutions name two different files → ambiguous → no edge
