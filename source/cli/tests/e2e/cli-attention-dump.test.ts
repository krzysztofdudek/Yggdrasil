// =============================================================================
// CLI E2E — the SILENT feature-field index + hidden `--attention-dump`.
//
// Pins the public CLI surface (spawn the built bin.js):
//   - `yg check` maintains a local `.yggdrasil/.feature-field.json` and self-ignores
//     it (git never stages it),
//   - the hidden `--attention-dump` prints plain-language calibration output, exits 0,
//     and writes NOTHING (the index on disk is untouched),
//   - `yg check --approve --dry-run` writes no index (byproduct-free preview).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function tsFileWithIfs(n: number): string {
  const lines = ['export function f(): number {'];
  for (let i = 0; i < n; i++) lines.push(`  if (globalThis) { return ${i}; }`);
  lines.push('  return -1;');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/** Build a fresh fixture with one node owning six same-language files (one structural outlier). */
function makeFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-attn-${label}-`));
  w(dir, '.yggdrasil/yg-architecture.yaml', `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`);
  w(dir, '.yggdrasil/yg-config.yaml', `reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n`);
  w(dir, '.yggdrasil/model/svc/yg-node.yaml', `name: Svc\ndescription: service unit\ntype: service\nmapping:\n  - src/svc\n`);
  [1, 2, 3, 2, 1, 40].forEach((n, i) => w(dir, `src/svc/file${i}.ts`, tsFileWithIfs(n)));
  return dir;
}

const INDEX_REL = path.join('.yggdrasil', '.feature-field.json');

describe.skipIf(!distExists)('CLI E2E — feature-field index + --attention-dump', () => {
  it('`yg check` writes the index and git never stages it (self-ignored)', () => {
    const dir = makeFixture('write');
    try {
      const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
      git(['init', '-q']);
      git(['config', 'user.email', 't@t.t']);
      git(['config', 'user.name', 't']);

      const res = run(['check'], dir);
      expect(res.status).toBe(0);
      expect(existsSync(path.join(dir, INDEX_REL))).toBe(true);

      // Stage everything; the gitignored index must NOT be staged.
      git(['add', '-A']);
      const staged = git(['status', '--porcelain']).stdout;
      expect(staged).not.toContain('.feature-field.json');
      // And the .yggdrasil/.gitignore carries the line.
      const gi = readFileSync(path.join(dir, '.yggdrasil', '.gitignore'), 'utf-8');
      expect(gi).toContain('.feature-field.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('`--attention-dump` prints plain-language calibration, exits 0, and writes nothing', () => {
    const dir = makeFixture('dump');
    try {
      // Prime the index with a normal check.
      run(['check'], dir);
      const before = readFileSync(path.join(dir, INDEX_REL), 'utf-8');

      const res = run(['check', '--attention-dump'], dir);
      expect(res.status).toBe(0);
      expect(res.stdout.length).toBeGreaterThan(0);
      // Plain language — the outlier is surfaced without statistics jargon.
      expect(res.stdout).toMatch(/structurally unusual|worth a closer read/);
      expect(res.stdout).toContain('src/svc/file5.ts');
      expect(res.stdout.toLowerCase()).not.toContain('z-score');
      expect(res.stdout.toLowerCase()).not.toContain('mad');
      expect(res.stdout.toLowerCase()).not.toContain('percentile');

      // Writes NOTHING — the index on disk is byte-identical.
      const after = readFileSync(path.join(dir, INDEX_REL), 'utf-8');
      expect(after).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('`yg check --approve --dry-run` writes no index (byproduct-free preview)', () => {
    const dir = makeFixture('dryrun');
    try {
      const res = run(['check', '--approve', '--dry-run'], dir);
      expect(res.status).toBe(0);
      expect(existsSync(path.join(dir, INDEX_REL))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('`yg check --approve` maintains the index (via the fill report) and git never stages it', () => {
    const dir = makeFixture('approve');
    try {
      const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
      git(['init', '-q']);
      git(['config', 'user.email', 't@t.t']);
      git(['config', 'user.name', 't']);

      // No aspects in the fixture, so --approve fills nothing but still runs its post-fill report.
      const res = run(['check', '--approve'], dir);
      expect(res.status).toBe(0);
      // The `--approve` reporting path produced the index with the live outlier.
      expect(existsSync(path.join(dir, INDEX_REL))).toBe(true);
      const index = JSON.parse(readFileSync(path.join(dir, INDEX_REL), 'utf-8')) as {
        files: Record<string, unknown>;
      };
      expect(Object.keys(index.files)).toContain('src/svc/file5.ts');

      // Still gitignored — never staged.
      git(['add', '-A']);
      expect(git(['status', '--porcelain']).stdout).not.toContain('.feature-field.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
