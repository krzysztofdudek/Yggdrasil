---
id: typescript-package-main-directory-edge
language: typescript
category: import
expectation: edge
cites: "TS/Node directory resolution — a directory's package.json `types`/`main` before `index`"
---

## Rule

A relative import of a directory that holds a package.json (`import '../b'`) resolves to that package.json's `types`/`typings`/`module`/`main` entry before the directory index, as TypeScript and Node do.

## Files

```json path=r/b/package.json
{ "main": "./lib.js" }
```

```ts path=r/b/lib.ts
export const x = 1;
```

```ts path=r/app/use.ts
import { x } from '../b';
console.log(x);
```

## Expect

- r/app/use.ts:1 -> node:b      # package.json `main` ./lib.js → r/b/lib.ts
