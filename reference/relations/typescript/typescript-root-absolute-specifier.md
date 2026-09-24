---
id: typescript-root-absolute-specifier
language: typescript
category: trap
expectation: edge
cites: "Vite / Next.js — a root-absolute import resolves from the project root"
---

## Rule

A root-absolute specifier (`/shared/util`) is the bundler convention for the project root; the resolver joins it onto the importing file's package root (the nearest ancestor with a package.json). It is never joined onto the importer's own directory, which here would reach the decoy `src/a/shared/util/index.ts`.

## Files

```json path=package.json
{ "name": "app" }
```

```ts path=shared/util.ts
export const u = 1;
```

```ts path=src/a/shared/util/index.ts
export const u = 2;
```

```ts path=src/a/use.ts
import { u } from '/shared/util';
console.log(u);
```

## Expect

- src/a/use.ts:1 -> node:shared      # package root, not the importer's dir (decoy node util)
