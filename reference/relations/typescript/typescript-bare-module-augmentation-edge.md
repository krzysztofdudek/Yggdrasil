---
id: typescript-bare-module-augmentation-edge
language: typescript
category: usage-site
expectation: edge
cites: "TS Handbook — Declaration Merging, module augmentation (in a module file `declare module 'pkg'` augments pkg); Yggdrasil type-only rule"
---

## Rule

In a module file (one with a top-level `import` or `export`), `declare module '@acme/b' { … }` augments the module `@acme/b` names; the compiler merges it into that module's declarations. When the name resolves to an in-repo package, the augmenting file depends on that package and gives an edge at the `declare module` line. An external package stays silent like any external import. In a script file the same header is an ambient declaration instead (typescript-ambient-declare-module-silence), and a wildcard pattern (`'*.css'`) never names a module. A type-only reference is a dependency like a value import: the importing file compiles only against the module it names, so changing or removing that module breaks it. Every spelling of a type-only reference therefore gives an edge (see typescript-import-type-whole-statement-edge for the rule).

## Files

```json path=packages/b/package.json
{ "name": "@acme/b", "main": "./index.ts" }
```

```ts path=packages/b/index.ts
export interface Options { base: boolean }
```

```ts path=packages/a/augment.ts
declare module '@acme/b' {
  interface Options { extra: boolean }
}
declare module 'external-lib' {
  interface Other { x: number }
}
export {};
```

## Expect

- packages/a/augment.ts:1 -> node:b      # augmentation of an in-repo package; line 4 augments an external package → silent
