---
id: typescript-relative-module-augmentation
language: typescript
category: usage-site
expectation: edge
cites: "TS Handbook — Declaration Merging, module augmentation (`declare module './x'` merges into the declarations of ./x); Yggdrasil type-only rule"
---

## Rule

`declare module './m' { … }` augments the declarations of `./m`: it merges into that module's types, and the compiler rejects it when `./m` cannot be resolved. The augmenting file depends on `./m` as much as a type-only import does, so it gives an edge at the `declare module` line. A relative name is always an augmentation (TypeScript accepts a relative name nowhere else). A non-relative name is an augmentation in a module file (typescript-bare-module-augmentation-edge) and an ambient declaration in a script file (typescript-ambient-declare-module-silence). A type-only reference is a dependency like a value import: the importing file compiles only against the module it names, so changing or removing that module breaks it. Every spelling of a type-only reference therefore gives an edge (see typescript-import-type-whole-statement-edge for the rule).

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

- r/app/augment.ts:1 -> node:b      # the augmentation depends on the module it augments
