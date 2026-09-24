---
id: typescript-relative-module-augmentation
language: typescript
category: usage-site
expectation: silence
cites: "TS Handbook — Declaration Merging, module augmentation (`declare module './x'` adds declarations only)"
---

## Rule

`declare module './m' { … }` augments the declarations of `./m`. It is a declaration-only construct: nothing is loaded at runtime, so it is silent under the type-only rule. (The file usually also imports `./m` for real, and that import gives the edge.) A relation edge records a runtime dependency. TypeScript erases every type-only construct from the emitted JavaScript, so every spelling of a type-only reference is silent, the statement forms (`import type`, `export type`, all-inline `type` clauses; see typescript-import-type-whole-statement-silence) and the type-position forms alike.

## Files

```ts path=r/b/value.ts
export interface Opts { base: boolean }
```

```ts path=r/app/augment.ts
declare module '../b/value' {
  interface Opts { extra: boolean }
}
export {};
```

## Expect

- silence      # augmentation is declaration-only → no edge
