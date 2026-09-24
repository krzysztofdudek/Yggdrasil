---
id: typescript-vi-mock-silence
language: typescript
category: dynamic
expectation: silence
cites: "Vitest/Jest — `vi.mock('path')` / `jest.mock('path')` register a module replacement"
---

## Rule

`vi.mock('../b/value')` registers a replacement for a module; it is an ordinary call whose string argument the test framework interprets, not an import. The dependency, when there is one, is the import that follows it; the registration alone gives no edge.

## Files

```ts path=r/b/value.ts
export const x = 1;
```

```ts path=r/app/use.test.ts
vi.mock('../b/value');
jest.mock('../b/value');
```

## Expect

- silence      # a mock registration is a call argument, not an import
