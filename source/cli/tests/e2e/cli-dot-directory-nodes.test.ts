// =============================================================================
// CLI E2E — nodes under a dot-directory in .yggdrasil/model/.
//
// Mirroring source paths under model/ is the natural convention, so CI workflow
// and editor-config rules end up in model/.github/ and model/.vscode/. The model
// walk used to skip every dot-named directory, so such a node was never loaded:
// its enforced rules never ran and the gate passed over a violating file. The
// node must load like any other, and its rules must gate.
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
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-dot-node-'));
  const init = spawnSync('node', [BIN_PATH, 'init', '--no-reviewer'], { cwd: dir, encoding: 'utf-8' });
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
  const w = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  };
  w('src/a.js', 'export const a = 1;\n');
  w('.github/workflows/x.js', 'export function f() {\n  debugger;\n}\n');
  w('.yggdrasil/aspects/no-debugger/yg-aspect.yaml', 'name: no-debugger\ndescription: "No debugger statements."\nerrs: exact\nreviewer:\n  type: deterministic\nstatus: enforced\nreview_by: 2027-01-01\n');
  w(
    '.yggdrasil/aspects/no-debugger/check.mjs',
    [
      'export function check(ctx) {',
      '  const out = [];',
      '  for (const f of ctx.files) {',
      "    f.content.split('\\n').forEach((line, i) => { if (/\\bdebugger\\b/.test(line)) out.push({ file: f.path, line: i + 1, message: 'debugger statement' }); });",
      '  }',
      '  return out;',
      '}',
      '',
    ].join('\n'),
  );
  w('.yggdrasil/yg-architecture.yaml', 'node_types:\n  module:\n    description: A module\n    when:\n      path: "**"\n');
  w('.yggdrasil/model/src/yg-node.yaml', 'name: Src\ntype: module\ndescription: The source\nmapping:\n  - src\n');
  w('.yggdrasil/model/.github/yg-node.yaml', 'name: GitHub\ntype: module\ndescription: CI workflows\naspects: [no-debugger]\nmapping:\n  - .github\n');
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — nodes under a dot-directory in model/', () => {
  it('loads the node, lists it, and gates on its enforced rule', () => {
    const dir = project();
    try {
      const tree = spawnSync('node', [BIN_PATH, 'tree'], { cwd: dir, encoding: 'utf-8' });
      expect(tree.stdout).toContain('.github');

      const owner = spawnSync('node', [BIN_PATH, 'owner', '--file', '.github/workflows/x.js'], { cwd: dir, encoding: 'utf-8' });
      expect(owner.stdout).toContain('.github');

      const r = spawnSync('node', [BIN_PATH, 'check', '--approve', '--only-deterministic'], { cwd: dir, encoding: 'utf-8', timeout: 60_000 });
      const all = (r.stdout ?? '') + (r.stderr ?? '');
      expect(all).not.toContain('defined but not referenced');
      expect(all).toContain('no-debugger');
      expect(all).toContain('.github/workflows/x.js:2');
      expect(r.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
