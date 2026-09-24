---
id: typescript-import-attribute-json-edge
language: typescript
category: import
expectation: edge
cites: "TS 5.3 import attributes; a `.json` specifier names the JSON file itself"
---

## Rule

`import data from './a.json' with { type: 'json' }` loads the JSON file at runtime. The `with` clause is a trailer the extractor ignores, and an explicit non-source extension (`.json`) is probed literally, so the import resolves to the JSON file and its owning node.

## Files

```json path=r/data/a.json
{ "a": 1 }
```

```ts path=r/app/use.ts
import data from '../data/a.json' with { type: 'json' };
console.log(data);
```

## Expect

- r/app/use.ts:1 -> node:data      # the JSON file is a real runtime dependency → edge to node data
