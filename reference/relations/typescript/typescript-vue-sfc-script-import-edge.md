---
id: typescript-vue-sfc-script-import-edge
language: typescript
category: import
expectation: edge
cites: "Vue single-file components — `<script setup lang='ts'>`"
---

## Rule

A Vue component's imports live in its `<script>` blocks. The relation pass parses a view of the component in which every byte outside a script body is blanked (line numbers kept) with the grammar the block's `lang` names, so its imports give edges at the component's own line numbers; importing a `.vue` file by its explicit extension resolves to it.

## Files

```vue path=r/ui/Panel.vue
<template>
  <div>{{ x }}</div>
</template>
<script setup lang="ts">
import { x } from '../b/value';
</script>
```

```ts path=r/b/value.ts
export const x = 1;
```

```ts path=r/app/main.ts
import Panel from '../ui/Panel.vue';
console.log(Panel);
```

## Expect

- r/ui/Panel.vue:5 -> node:b      # script-block import
- r/app/main.ts:1 -> node:ui      # explicit `.vue` target
