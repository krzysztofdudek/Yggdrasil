// =============================================================================
// CLI E2E — a structural cycle blocks only the context it touches.
//
// A cycle among some nodes used to block `yg context` for EVERY node in the
// repository ("affecting this node's context"), and the message printed a DFS
// path whose first hops were not in the cycle at all. Now the cycle is reported
// once per strongly connected component, and `yg context` refuses only for a
// node in the cycle or one that depends on a member directly.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(__dirname, '../..', 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-cycle-scope-'));
  const init = spawnSync('node', [BIN_PATH, 'init', '--no-reviewer'], { cwd: dir, encoding: 'utf-8' });
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
  const w = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  };
  w('.yggdrasil/yg-architecture.yaml', 'node_types:\n  module:\n    description: A module\n    when:\n      path: "src/**"\n');
  const node = (name: string, uses: string[]) => {
    w(`src/${name}/index.ts`, `export const ${name} = 1;\n`);
    const rels = uses.length === 0 ? '' : `relations:\n${uses.map((t) => `  - target: ${t}\n    type: uses\n`).join('')}`;
    w(`.yggdrasil/model/${name}/yg-node.yaml`, `name: ${name}\ntype: module\ndescription: The ${name} module\nmapping:\n  - src/${name}\n${rels}`);
  };
  // aa depends on the cycle bb <-> cc but is not in it; zz is unrelated.
  node('aa', ['bb']);
  node('bb', ['cc']);
  node('cc', ['bb']);
  node('zz', []);
  return dir;
}

const run = (dir: string, args: string[]) => {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd: dir, encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, all: (r.stdout ?? '') + (r.stderr ?? '') };
};

describe.skipIf(!distExists)('CLI E2E — structural cycle scope', () => {
  it('reports the cycle once, without the DFS prefix, and blocks only the nodes it touches', () => {
    const dir = project();
    try {
      const check = run(dir, ['check', '--no-approve']);
      expect(check.status).toBe(1);
      expect(check.all).toContain('bb -> cc -> bb');
      expect(check.all).not.toContain('aa -> bb');

      const unrelated = run(dir, ['context', '--node', 'zz']);
      expect(unrelated.all).not.toContain('build-context blocked');
      expect(unrelated.status).toBe(0);
      expect(run(dir, ['context', '--file', 'src/zz/index.ts']).status).toBe(0);

      const member = run(dir, ['context', '--node', 'cc']);
      expect(member.status).toBe(1);
      expect(member.all).toContain('build-context blocked');

      const dependent = run(dir, ['context', '--node', 'aa']);
      expect(dependent.status).toBe(1);
      expect(dependent.all).toContain('bb -> cc -> bb');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
