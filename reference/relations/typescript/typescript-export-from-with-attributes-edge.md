---
id: typescript-export-from-with-attributes-edge
language: typescript
category: trap
expectation: edge
cites: "ES2025 import attributes on re-exports (`export … from … with { … }`); every shipped JS/TS grammar ERRORs on it"
---

## Rule

`export { default as config } from './c.json' with { type: 'json' }` is valid, but the shipped grammars do not parse attributes on a re-export and the statement disappears into an ERROR. The ERROR-region rescan recovers it; the next statement is unaffected.

## Files

```json path=r/b/config.json
{ "a": 1 }
```

```ts path=r/c/value.ts
export const C = 1;
```

```ts path=r/app/use.ts
export { default as config } from '../b/config.json' with { type: 'json' };
import { C } from '../c/value';
console.log(C);
```

## Expect

- r/app/use.ts:1 -> node:b      # re-export with attributes recovered
- r/app/use.ts:2 -> node:c      # following import unaffected
