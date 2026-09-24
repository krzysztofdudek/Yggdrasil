---
id: typescript-tsconfig-baseurl-edge
language: typescript
category: import
expectation: edge
cites: "TS Module Resolution — `baseUrl` (a non-relative name resolves from baseUrl before package lookup)"
---

## Rule

With `baseUrl` set and no `paths` pattern matching, a non-relative specifier (`src/c/value`) is joined onto `baseUrl` and probed; the compiler resolves it there before any package lookup.

## Files

```json path=tsconfig.json
{ "compilerOptions": { "baseUrl": "." } }
```

```ts path=src/c/value.ts
export const W = 1;
```

```ts path=src/a/use.ts
import { W } from 'src/c/value';
console.log(W);
```

## Expect

- src/a/use.ts:1 -> node:c      # baseUrl-rooted specifier → src/c/value.ts
