---
id: typescript-new-url-import-meta-edge
language: typescript
category: dynamic
expectation: edge
cites: "HTML/bundlers — `new URL('./x', import.meta.url)` (Vite, webpack 5, Parcel, esbuild)"
---

## Rule

`new URL('<literal>', import.meta.url)` references a file relative to the module; bundlers resolve and ship it. It is an edge when the first argument is a literal and the base is literally `import.meta.url`; any other base is a runtime URL and stays silent.

## Files

```js path=r/b/worker.js
self.onmessage = () => {};
```

```ts path=r/app/use.ts
const url = new URL('../b/worker.js', import.meta.url);
const other = new URL('../b/worker.js', location.href);
export { url, other };
```

## Expect

- r/app/use.ts:1 -> node:b      # import.meta.url base → edge; line 2 (runtime base) stays silent
