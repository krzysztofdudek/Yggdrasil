---
id: typescript-tsconfig-extends-paths-edge
language: typescript
category: import
expectation: edge
cites: "TS tsconfig `extends` (paths inherited; substitutions resolve from the directory of the config that declares them)"
---

## Rule

An Nx-style layout: the project tsconfig.json extends a shared base that declares the aliases. Inherited `paths` resolve from the directory of the config that declares them (here the repository root), not from the extending config.

## Files

```json path=tsconfig.base.json
{ "compilerOptions": { "paths": { "@acme/shared": ["libs/shared/index.ts"] } } }
```

```json path=apps/web/tsconfig.json
{ "extends": "../../tsconfig.base.json" }
```

```ts path=libs/shared/index.ts
export const S = 1;
```

```ts path=apps/web/main.ts
import { S } from '@acme/shared';
console.log(S);
```

## Expect

- apps/web/main.ts:1 -> node:shared      # inherited exact-key alias → libs/shared/index.ts
