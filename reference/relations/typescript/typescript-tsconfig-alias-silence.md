---
id: typescript-tsconfig-alias-silence
language: typescript
category: trap
expectation: silence
cites: "TS Module Resolution — a non-relative specifier with no tsconfig mapping and no in-repo package is external"
---

## Rule

An alias-looking specifier (`@app/x`) with no tsconfig `paths`/`baseUrl` that maps it and no in-repo package.json named `@app/x` is an external package. A same-named in-repo directory is never guessed at.

## Files

```ts path=r/app-x/value.ts
export const X = 1;
```

```ts path=r/app/use.ts
import { X } from '@app/x';
console.log(X);
```

## Expect

- silence      # no tsconfig, no in-repo package named `@app/x` → external → no edge

## Why

The mapping is project-defined; without a tsconfig or package.json that defines it, any in-repo match would be a guess.
