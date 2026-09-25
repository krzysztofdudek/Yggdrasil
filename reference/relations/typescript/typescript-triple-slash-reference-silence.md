---
id: typescript-triple-slash-reference-silence
language: typescript
category: trap
expectation: silence
cites: "TS Handbook — Triple-Slash Directives (`/// <reference path/types=… />` is a comment to the grammar); research H4"
---

## Rule

A triple-slash directive `/// <reference path="./other.d.ts" />` (or `/// <reference types="node" />`) is a COMMENT to the grammar, not an import statement. The extractor walks syntax, never comment text, so the directive emits nothing. This is a limit of what is read, not a policy: a `path` reference makes the file compile against the referenced declarations and is a dependency in the sense of the type-only rule (typescript-import-type-whole-statement-edge), but it is not detected. A `types` reference names an external `@types` package and would stay silent anyway.

## Files

```ts path=r/globals/types.ts
export const g = 1;
```

```ts path=r/app/use.ts
/// <reference path="../globals/types.ts" />
/// <reference types="node" />
const x = 1;
```

## Expect

- silence      # triple-slash directives are comments, which the extractor does not read → no edge, even though r/globals exists

## Why

Triple-slash references are a legacy pre-ESM mechanism, rare in module code; reading comment text would put a second, regex-level parser beside the grammar for a form an `import type` replaces.
