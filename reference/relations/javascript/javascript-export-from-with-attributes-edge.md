---
id: javascript-export-from-with-attributes-edge
language: javascript
category: trap
expectation: edge
cites: "ES2025 import attributes on re-exports; the shipped JavaScript grammar ERRORs on it"
---

## Rule

`export { default as data } from './d.json' with { type: 'json' }` disappears into an ERROR in the shipped JavaScript grammar; the ERROR-region rescan recovers it.

## Files

```json path=r/b/data.json
{ "a": 1 }
```

```js path=r/app/use.js
export { default as data } from '../b/data.json' with { type: 'json' };
```

## Expect

- r/app/use.js:1 -> node:b      # recovered re-export
