// =============================================================================
// CLI E2E — `yg advise` names a declared relation no code backs
// (relation-declared-unused).
//
// `yg check` blocks code that depends on a component with no declared relation;
// the opposite — a relation declared while no import uses it — widened what the
// component may depend on and what `yg impact` reports, and nothing said so. The
// relation pass `yg advise` already runs now lists such relations, one item per
// component, as advice: the relation may stand for a dependency the extractor
// cannot see, so removing it is the user's call.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(__dirname, '../..', 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; status: number | null } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: result.stdout ?? '', status: result.status };
}

function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/**
 * Component `app` declares `uses` to `lib` (imported), to `ghost` (which `tool`
 * imports, but `app` does not) and to `data` (a tree no code imports, read by path).
 */
function makeFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-advise-rel-unused-'));
  w(dir, '.yggdrasil/yg-architecture.yaml', `node_types:\n  unit:\n    description: 'a unit'\n    log_required: false\n`);
  w(dir, '.yggdrasil/yg-config.yaml', `version: "6.0.0"\n`);
  w(dir, '.yggdrasil/model/app/yg-node.yaml', `name: App\ndescription: the app\ntype: unit\nmapping:\n  - src/app\nrelations:\n  - { target: lib, type: uses }\n  - { target: ghost, type: uses }\n  - { target: data, type: uses }\n`);
  w(dir, '.yggdrasil/model/lib/yg-node.yaml', `name: Lib\ndescription: a library\ntype: unit\nmapping:\n  - src/lib\n`);
  w(dir, '.yggdrasil/model/ghost/yg-node.yaml', `name: Ghost\ndescription: nothing imports it\ntype: unit\nmapping:\n  - src/ghost\n`);
  w(dir, 'src/app/main.ts', `import { helper } from '../lib/helper';\nexport const main = () => helper();\n`);
  w(dir, 'src/lib/helper.ts', `export const helper = () => 1;\n`);
  w(dir, 'src/ghost/index.ts', `export const ghost = 1;\n`);
  w(dir, '.yggdrasil/model/tool/yg-node.yaml', `name: Tool\ndescription: uses ghost\ntype: unit\nmapping:\n  - src/tool\nrelations:\n  - { target: ghost, type: uses }\n`);
  w(dir, 'src/tool/run.ts', `import { ghost } from '../ghost/index';\nexport const run = () => ghost;\n`);
  w(dir, '.yggdrasil/model/data/yg-node.yaml', `name: Data\ndescription: files read by path\ntype: unit\nmapping:\n  - src/data\n`);
  w(dir, 'src/data/table.ts', `export const table = [1];\n`);
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — yg advise relation-declared-unused', () => {
  it('names the declared relation with no import behind it, and not the one the code uses (exit 0)', () => {
    const dir = makeFixture();
    try {
      const { status, stdout } = run(['advise', '--json'], dir);
      expect(status).toBe(0);
      const doc = JSON.parse(stdout) as { items: Array<{ id: string; what: string }> };
      const item = doc.items.find((i) => i.id === 'relation-declared-unused:app');
      expect(item?.what).toContain("'ghost'");
      expect(item?.what).not.toContain("'lib'");
      // No code imports `data` at all, so its missing import says nothing.
      expect(item?.what).not.toContain("'data'");
      expect(doc.items.filter((i) => i.id.startsWith('relation-declared-unused:'))).toHaveLength(1);
      expect(run(['advise'], dir).stdout).toContain('nomination[relation-declared-unused]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says nothing once the stale relation is removed', () => {
    const dir = makeFixture();
    try {
      w(dir, '.yggdrasil/model/app/yg-node.yaml', `name: App\ndescription: the app\ntype: unit\nmapping:\n  - src/app\nrelations:\n  - { target: lib, type: uses }\n`);
      const { status, stdout } = run(['advise'], dir);
      expect(status).toBe(0);
      expect(stdout).not.toContain('relation-declared-unused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
