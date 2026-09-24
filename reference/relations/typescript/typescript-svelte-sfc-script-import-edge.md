---
id: typescript-svelte-sfc-script-import-edge
language: typescript
category: import
expectation: edge
cites: "Svelte components — `<script>` and `<script context='module'>` blocks"
---

## Rule

A Svelte component's imports live in its `<script>` blocks, parsed like a Vue component's; a block without `lang` is JavaScript.

## Files

```svelte path=r/ui/Button.svelte
<script>
  import { label } from '../b/value.js';
</script>
<button>{label}</button>
```

```js path=r/b/value.js
export const label = "ok";
```

## Expect

- r/ui/Button.svelte:2 -> node:b      # script-block import
