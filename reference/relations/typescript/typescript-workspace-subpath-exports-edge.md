---
id: typescript-workspace-subpath-exports-edge
language: typescript
category: import
expectation: edge
cites: "Node package `exports` — subpath entries with conditions"
---

## Rule

A subpath import of a workspace package (`@acme/b/feature`) resolves through that subpath's `exports` entry. Conditions are read in declaration order and the first target that names a repository file wins, so a `types` entry pointing at source beats an `import` entry pointing at unbuilt `dist/` output.

## Files

```json path=packages/b/package.json
{
  "name": "@acme/b",
  "exports": {
    ".": "./index.ts",
    "./feature": { "types": "./feature.ts", "import": "./dist/feature.js" }
  }
}
```

```ts path=packages/b/index.ts
export const X = 1;
```

```ts path=packages/b/feature.ts
export const F = 1;
```

```ts path=packages/a/use.ts
import { F } from '@acme/b/feature';
console.log(F);
```

## Expect

- packages/a/use.ts:1 -> node:b      # `exports['./feature']` → packages/b/feature.ts
