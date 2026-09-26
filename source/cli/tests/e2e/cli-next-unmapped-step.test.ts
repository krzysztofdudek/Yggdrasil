// =============================================================================
// CLI E2E — the step `yg check` names for a file no component owns runs, and
// helps.
//
// The step is executed exactly as the machine document hands it over
// (`next.command`, an argument vector), on a tree where the unmapped file sits
// beside files a component maps — and where its path holds a space, so the
// argument vector is proven to keep it whole. The command must succeed, name
// that component as the candidate owner (in its text and in its JSON), and
// never say the file itself is to be edited.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitFixture } from '../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(__dirname, '../..', 'dist', 'bin.js');

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  for (const k of ['FORCE_COLOR', 'CI', 'GITHUB_ACTIONS']) delete e[k];
  return e;
}
const run = (dir: string, args: string[]) => {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd: dir, encoding: 'utf-8', timeout: 90_000, env: env() });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** One component mapping one file of `src/<dir>/`, and an unmapped file beside it; optionally a lone unmapped file elsewhere. */
function project(dir: string, opts: { lone?: boolean } = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'yg-next-unmapped-'));
  runGitFixture(root, ['init', '-q', '-b', 'main']);
  const w = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  };
  w('.yggdrasil/yg-config.yaml', 'version: "6.0.0"\ncoverage:\n  required:\n    - src/\n  excluded: []\n');
  w('.yggdrasil/yg-architecture.yaml', "node_types:\n  service:\n    description: 'A service.'\n    when:\n      path: \"src/**\"\n");
  w('.yggdrasil/model/billing/yg-node.yaml', `name: Billing\ntype: service\ndescription: "Billing."\nmapping:\n  - src/${dir}/charge.ts\n`);
  w(`src/${dir}/charge.ts`, 'export const charge = 1;\n');
  w(`src/${dir}/refund.ts`, 'export const refund = 1;\n');
  if (opts.lone === true) w('src/alone/orphan.ts', 'export const o = 1;\n');
  const init = run(root, ['init', '--upgrade']);
  if (init.status !== 0) throw new Error(`init --upgrade failed: ${init.stdout}${init.stderr}`);
  return root;
}

function nextCommand(root: string): string[] {
  const doc = JSON.parse(run(root, ['check', '--json']).stdout) as { next: { command: string[] | null; target: { file?: string } } };
  expect(doc.next.target.file).toBeUndefined();
  expect(doc.next.command).not.toBeNull();
  return doc.next.command!;
}

describe.skipIf(!existsSync(BIN_PATH))('CLI E2E — the step for an unmapped file runs and names its likely owner', () => {
  it('next.command, run as handed over, exits 0 and names the component mapping its directory — with a space in the path', () => {
    const root = project('billing api');
    try {
      const argv = nextCommand(root);
      expect(argv).toEqual(['yg', 'owner', '--file', 'src/billing api/refund.ts']);
      const text = run(root, argv.slice(1));
      expect(text.status).toBe(0);
      expect(text.stdout).toContain('src/billing api/refund.ts -> no graph coverage. Candidate owners');
      expect(text.stdout).toContain('  - billing (');
      const json = run(root, [...argv.slice(1), '--json']);
      expect(json.status).toBe(0);
      const doc = JSON.parse(json.stdout) as { kind: string; candidates: Array<{ node: string; sameDirEntries: number }>; next: string | null };
      expect(doc.kind).toBe('unmapped');
      expect(doc.candidates).toEqual([{ node: 'billing', sameDirEntries: 1 }]);
      expect(doc.next).toBe('yg context --node billing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('with nothing mapped in its directory, the step still succeeds and says a new component is the answer', () => {
    const root = project('billing', { lone: true });
    try {
      const out = run(root, ['owner', '--file', 'src/alone/orphan.ts', '--json']);
      expect(out.status).toBe(0);
      const doc = JSON.parse(out.stdout) as { kind: string; candidates: unknown[] };
      expect(doc.kind).toBe('unmapped');
      expect(doc.candidates).toEqual([]);
      expect(run(root, ['owner', '--file', 'src/alone/orphan.ts']).stdout).toContain('No component maps anything in its directory.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
