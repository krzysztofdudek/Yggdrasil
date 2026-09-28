// =============================================================================
// CLI E2E — `yg impact --type` previews what `enforce: strict` will report.
//
// The contract: run before the flag is set, the strict coverage gap lists the
// same orphans and misplaced files `yg check` reports once it is set — files
// owned through a directory or glob mapping entry included. After the flag is
// set, the two still agree.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { runGitFixture } from '../support/git-fixture.js';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findIssues, parseJson } from '../support/assert-output.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const CONFIG = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle', '.yggdrasil', 'yg-config.yaml');
const distExists = existsSync(BIN_PATH);

function yg(dir: string, args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd: dir, encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } });
  return { status: r.status, stdout: r.stdout ?? '' };
}

const write = (dir: string, rel: string, text: string): void => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};

/** A `service` type matching `*.service.ts`, one service owned through a directory entry, one in a library node, one in no node. */
function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-impact-strict-'));
  cpSync(CONFIG, path.join(dir, '.yggdrasil', 'yg-config.yaml'));
  write(dir, '.yggdrasil/yg-architecture.yaml', [
    'node_types:',
    '  module:',
    "    description: 'Groups components.'",
    '  service:',
    "    description: 'A service file.'",
    '    when:',
    '      path: "src/**/*.service.ts"',
    '    parents: [module]',
    '  library:',
    "    description: 'Library code.'",
    '    when:',
    '      path: "src/lib/**"',
    '    parents: [module]',
    '',
  ].join('\n'));
  write(dir, '.yggdrasil/model/app/yg-node.yaml', 'name: App\ndescription: The app.\ntype: module\n');
  write(dir, '.yggdrasil/model/app/svc/yg-node.yaml', 'name: Svc\ndescription: Services.\ntype: service\nmapping:\n  - src/svc/\n');
  write(dir, '.yggdrasil/model/app/lib/yg-node.yaml', 'name: Lib\ndescription: Library.\ntype: library\nmapping:\n  - src/lib/\n');
  write(dir, 'src/svc/a.service.ts', 'export const a = 1;\n');
  write(dir, 'src/lib/b.service.ts', 'export const b = 1;\n');
  write(dir, 'src/d.service.ts', 'export const d = 1;\n');
  runGitFixture(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

/** The files listed under one heading of the strict coverage gap. */
function gapList(out: string, heading: 'Orphans' | 'Misplaced'): string[] {
  const block = new RegExp(`^ {2}${heading} \\(.*\\): \\d+\\n((?: {4}\\S.*\\n)*)`, 'm').exec(out)?.[1] ?? '';
  return block.split('\n').filter((l) => l.trim() !== '').map((l) => l.trim().split(' ')[0]);
}

describe.skipIf(!distExists)('CLI E2E — impact --type previews the strict coverage gap', () => {
  // Claim (docs/cli-reference.md): "computed by the same scan `yg check` runs. Before the flag is set the gap is labelled a preview of what setting it would report."
  it('lists, before the flag is set, the orphans and misplaced files check reports after', () => {
    const dir = project();
    try {
      const preview = yg(dir, ['impact', '--type', 'service']);
      expect(preview.status).toBe(0);
      const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
      writeFileSync(archPath, readFileSync(archPath, 'utf-8').replace('      path: "src/**/*.service.ts"\n', '      path: "src/**/*.service.ts"\n    enforce: strict\n'));
      const doc = parseJson(yg(dir, ['check', '--json']).stdout);
      const orphans = findIssues(doc, { code: 'type-strict-orphan' }).map((i) => String(i.unit).replace(/^file:/, ''));
      const misplacedOwners = findIssues(doc, { code: 'type-strict-misplaced' }).map((i) => i.node);
      expect(orphans).toEqual(['src/d.service.ts']);
      expect(misplacedOwners).toEqual(['app/lib']);
      expect(gapList(preview.stdout, 'Orphans')).toEqual(orphans);
      expect(gapList(preview.stdout, 'Misplaced')).toEqual(['src/lib/b.service.ts']);
      const after = yg(dir, ['impact', '--type', 'service']);
      expect(gapList(after.stdout, 'Orphans')).toEqual(orphans);
      expect(gapList(after.stdout, 'Misplaced')).toEqual(['src/lib/b.service.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
