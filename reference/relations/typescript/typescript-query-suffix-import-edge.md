---
id: typescript-query-suffix-import-edge
language: typescript
category: import
expectation: edge
cites: "Vite — `?raw`/`?url`/`?worker` query suffixes"
---

## Rule

A bundler query suffix (`../b/worker.ts?worker`, `./icon.svg?raw`) is a loader hint, not part of the path. It is stripped before resolution.

## Files

```ts path=r/b/worker.ts
self.onmessage = () => {};
```

```ts path=r/app/use.ts
import Worker from '../b/worker.ts?worker';
new Worker();
```

## Expect

- r/app/use.ts:1 -> node:b      # `?worker` stripped → r/b/worker.ts
