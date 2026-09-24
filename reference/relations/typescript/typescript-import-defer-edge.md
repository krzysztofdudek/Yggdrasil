---
id: typescript-import-defer-edge
language: typescript
category: import
expectation: edge
cites: "TC39 import defer (TS 5.9 `import defer * as ns from`); the shipped grammar parses it with an ERROR"
---

## Rule

`import defer * as ns from './m'` loads the module lazily but still names it statically. The shipped grammar does not know `defer`; the edge survives through the statement's source or the ERROR-region rescan.

## Files

```ts path=r/b/value.ts
export const x = 1;
```

```ts path=r/app/use.ts
import defer * as ns from '../b/value';
export const read = () => ns.x;
```

## Expect

- r/app/use.ts:1 -> node:b      # deferred import is still a dependency
