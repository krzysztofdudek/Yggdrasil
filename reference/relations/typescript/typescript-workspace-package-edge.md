---
id: typescript-workspace-package-edge
language: typescript
category: import
expectation: edge
cites: "npm/pnpm/yarn workspaces; Node package `exports` (root subpath)"
---

## Rule

An in-repo package imported by its package.json `name` (`@acme/b`) is a workspace dependency. The resolver indexes every package.json outside `node_modules` by name and resolves the root import through `exports['.']`.

## Files

```json path=packages/b/package.json
{ "name": "@acme/b", "exports": { ".": "./index.ts" } }
```

```ts path=packages/b/index.ts
export const X = 1;
```

```ts path=packages/a/use.ts
import { X } from '@acme/b';
console.log(X);
```

## Expect

- packages/a/use.ts:1 -> node:b      # workspace package name → packages/b/index.ts
