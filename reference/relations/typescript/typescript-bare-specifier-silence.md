---
id: typescript-bare-specifier-silence
language: typescript
category: trap
expectation: silence
cites: "TS Module Resolution — a bare specifier with no in-repo definition is external"
---

## Rule

A bare specifier (`lodash`) is an external package unless the repository itself defines it (a tsconfig mapping, or a package.json `name`). A specifier with a URL scheme (`node:path`) is never in-repo. A same-named in-repo directory is not a definition.

## Files

```ts path=r/lodash/value.ts
export const x = 1;
```

```ts path=r/app/use.ts
import x from 'lodash';
import path from 'node:path';
console.log(x, path);
```

## Expect

- silence      # no package.json names `lodash`, `node:` is a scheme → external → no edge, even though an in-repo r/lodash exists
