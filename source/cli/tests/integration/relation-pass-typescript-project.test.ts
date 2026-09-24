import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadGraph } from '../../src/core/graph-loader.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { makeResolvePathToFile } from '../../src/relations/resolve-path.js';

// The live pass over a TS/JS project whose dependencies run through project
// configuration and single-file components: tsconfig `paths`, an in-repo workspace
// package, a Vue component's `<script setup>` block (parsed as its script view by
// pass.ts itself, not by a test double), and the type-only rule. Node `app` declares
// no relations, so every cross-node edge is a violation the pass must report at the
// right file and line — and a type-only reference must report nothing.

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}
function node(root: string, id: string, mapping: string): void {
  write(root, `.yggdrasil/model/${id}/yg-node.yaml`, `name: ${id}\ntype: service\nmapping:\n  - ${mapping}\n`);
}

describe('relation pass — TypeScript project configuration and components', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'rel-ts-project-'));
    write(root, '.yggdrasil/yg-architecture.yaml', `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`);
    write(root, '.yggdrasil/yg-config.yaml', `version: "6.0.0"\nquality:\n  max_direct_relations: 10\n`);
    node(root, 'app', 'apps/web/**');
    node(root, 'ui', 'libs/ui/**');
    node(root, 'kit', 'packages/kit/**');
    node(root, 'types', 'libs/types/**');
    write(root, 'tsconfig.json', '{ "compilerOptions": { "paths": { "@ui/*": ["./libs/ui/*"] } } }\n');
    write(root, 'libs/ui/button.ts', 'export const button = 1;\n');
    write(root, 'libs/types/model.ts', 'export interface Model { id: string }\n');
    write(root, 'packages/kit/package.json', '{ "name": "@acme/kit", "exports": { ".": "./index.ts" } }\n');
    write(root, 'packages/kit/index.ts', 'export const kit = 1;\n');
    write(root, 'apps/web/main.ts', [
      "import { button } from '@ui/button';",
      "import { kit } from '@acme/kit';",
      "import type { Model } from '../../libs/types/model';",
      "type M = typeof import('../../libs/types/model');",
      "import Panel from './Panel.vue';",
      'export { button, kit, Panel };',
      'export type { Model, M };',
      '',
    ].join('\n'));
    write(root, 'apps/web/Panel.vue', [
      '<template>',
      '  <div>{{ button }}</div>',
      '</template>',
      '<script setup lang="ts">',
      "import { button } from '../../libs/ui/button';",
      '</script>',
      '',
    ].join('\n'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports aliased, workspace and component edges at their own lines, and nothing for type-only references', async () => {
    for (const run of ['cold', 'cached']) {
      const graph = await loadGraph(root);
      const result = await runRelationPass(graph, root, {
        extractorFor: extractorForLanguage,
        resolvePathToFile: makeResolvePathToFile(root),
        symbolIndexDir: path.join(root, '.yg-cache'),
      });
      const found = (result.violationsByNode.get('app')?.violations ?? [])
        .map((v) => `${v.fromFile}:${v.line} -> ${v.ownerNode}`)
        .sort();
      expect(found, run).toEqual([
        'apps/web/Panel.vue:5 -> ui',
        'apps/web/main.ts:1 -> ui',
        'apps/web/main.ts:2 -> kit',
      ]); // main.ts:3-4 (type-only) are silent; main.ts:5 (./Panel.vue) is intra-node
      expect(result.parseFailures, run).toHaveLength(0);
    }
  });
});
