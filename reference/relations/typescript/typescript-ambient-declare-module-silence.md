---
id: typescript-ambient-declare-module-silence
language: typescript
category: trap
expectation: silence
cites: "TS Modules Reference — ambient modules / pattern ambient modules (in a script file `declare module 'foo'` declares a shape; `'*.css'` names no file); research H3 (DELIBERATE-SILENCE)"
---

## Rule

In a script file (no top-level `import` or `export`), `declare module 'foo' { … }` is an ambient module declaration: it DECLARES the shape of a module whose implementation a bundler or loader supplies, rather than depending on an existing one. A wildcard pattern (`declare module '*.css'`) names no module at all. Neither is read as a specifier. The same header in a module file is an augmentation of an existing module and gives an edge (typescript-bare-module-augmentation-edge), and a relative name is always an augmentation (typescript-relative-module-augmentation). A real `import`/`require` nested inside an ambient block would still emit.

## Files

```ts path=r/foo/value.ts
export const x = 1;
```

```ts path=r/app/use.ts
declare module 'foo' {
  export const x: number;
}
declare module '*.css' {
  const url: string;
  export default url;
}
```

## Expect

- silence      # ambient declarations in a script file and wildcard patterns name no dependency → no edge, even though r/foo exists

## Why

An ambient declaration provides a module's types instead of consuming another module's, so reading its header as a specifier would manufacture a dependency on a same-named directory that the declaration never references.
