---
id: typescript-template-no-substitution-dynamic-import-edge
language: typescript
category: dynamic
expectation: edge
cites: "ECMAScript — a no-substitution template literal is a static string"
---

## Rule

A dynamic import whose argument is a backtick literal with no `${…}` (``import(`./m`)``) is as static as a quoted string and resolves the same way; an interpolated template stays silent (typescript-dynamic-import-template-silence).

## Files

```ts path=r/b/value.ts
export const x = 1;
```

```ts path=r/app/use.ts
export const load = () => import(`../b/value`);
```

## Expect

- r/app/use.ts:1 -> node:b      # no-substitution template → edge
