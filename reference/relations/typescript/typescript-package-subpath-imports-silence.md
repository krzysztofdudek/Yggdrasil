---
id: typescript-package-subpath-imports-silence
language: typescript
category: trap
expectation: silence
cites: "Node package `imports` — a `#` specifier with no entry is unresolvable"
---

## Rule

A `#`-specifier with no package.json `imports` entry that maps it (here: no package.json at all) names nothing the resolver can read, so it stays silent. A same-named in-repo directory is never guessed at.

## Files

```ts path=r/internal/x.ts
export const x = 1;
```

```ts path=r/app/use.ts
import { x } from '#internal/x';
console.log(x);
```

## Expect

- silence      # no `imports` map defines `#internal/x` → no edge
