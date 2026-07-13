// =============================================================================
// CLI E2E — the C8 structural-deviation aggregate line in `yg advise` (wave-6).
//
// Pins the public CLI surface (spawn the built bin.js). `yg advise` adds ONE
// aggregate Attention line summarizing how many files the local deviation index
// still records as LIVE structural outliers — counted under the SAME exact-bytes
// match rule `yg context --file` uses (a file whose bytes changed since the index
// was written is NOT counted). The line is a bare count pointing the reader at
// `yg context`; it lists no files and ranks nothing. Every scenario asserts exit 0
// (the attention layer never gates — G4).
//
//   1. 2 live entries + 1 stale (hash mismatch) → the verbatim line with M = 2
//   2. an empty index (files: {})               → the line is OMITTED (no "0 files")
//   3. no index file at all                      → the line is OMITTED
//   4. live entries + signals.attention: false  → the line is OMITTED (off-switch)
//   5. live entries + signals.attention: true   → the line is SHOWN (explicit on)
//
// Scenarios 4/5 pin the off-switch: `signals.attention: false` silences the per-file
// note in `yg context --file`, and the same switch must silence the `yg advise` C8
// aggregate that points the reader at that surface — otherwise the feed would steer a
// user toward a view they disabled. Scenario 1 already covers the default (key absent
// ⇒ ON); 4/5 guard both explicit directions.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

/** The C8 aggregate line, verbatim (only the count M varies). */
const C8_RE =
  /(\d+) files deviate structurally from their neighbors — shown in yg context when you work there\./g;

/** sha256 hex of the file's UTF-8 text — identical to the CLI's hashString(text). */
function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/** A minimal loadable graph (one node owning src/svc) so `yg advise` runs. */
function makeFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-advise-dev-${label}-`));
  w(
    dir,
    '.yggdrasil/yg-architecture.yaml',
    `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
  );
  w(
    dir,
    '.yggdrasil/yg-config.yaml',
    `reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n`,
  );
  w(dir, '.yggdrasil/model/svc/yg-node.yaml', `name: Svc\ndescription: service unit\ntype: service\nmapping:\n  - src/svc\n`);
  return dir;
}

function gitInit(dir: string): void {
  const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
}

const INDEX_REL = path.join('.yggdrasil', '.feature-field.json');
const DEV = [{ dim: 'branch-like', z: 25.6 }];

/** Write the local deviation index verbatim at .yggdrasil/.feature-field.json. */
function writeIndex(dir: string, files: Record<string, unknown>): void {
  w(dir, INDEX_REL, JSON.stringify({ v: 1, generatedAt: '2026-01-01T00:00:00.000Z', files }));
}

/**
 * Rewrite the fixture config with an explicit signals.attention switch. Keeps the
 * same reviewer tier makeFixture writes so the graph still loads; only adds the
 * top-level `signals:` block that governs the structural-attention off-switch.
 */
function setSignalsAttention(dir: string, attention: boolean): void {
  w(
    dir,
    '.yggdrasil/yg-config.yaml',
    `reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\nsignals:\n  attention: ${attention}\n`,
  );
}

/** Two live index entries over two real source files — enough to fire the C8 line. */
function seedTwoLiveEntries(dir: string): void {
  const a = 'export const a = 1;\n';
  const b = 'export const b = 2;\n';
  w(dir, 'src/svc/a.ts', a);
  w(dir, 'src/svc/b.ts', b);
  writeIndex(dir, {
    'src/svc/a.ts': { contentHash: contentHash(a), family: 'svc\x00typescript', deviations: DEV },
    'src/svc/b.ts': { contentHash: contentHash(b), family: 'svc\x00typescript', deviations: DEV },
  });
}

describe.skipIf(!distExists)('CLI E2E — yg advise C8 structural-deviation line', () => {
  it('1. shows the verbatim line with M = 2 when 2 entries are live and 1 is stale (exit 0)', () => {
    const dir = makeFixture('live');
    try {
      gitInit(dir);
      const a = 'export const a = 1;\n';
      const b = 'export const b = 2;\n';
      const c = 'export const c = 3;\n';
      w(dir, 'src/svc/a.ts', a);
      w(dir, 'src/svc/b.ts', b);
      w(dir, 'src/svc/c.ts', c);
      writeIndex(dir, {
        'src/svc/a.ts': { contentHash: contentHash(a), family: 'svc\x00typescript', deviations: DEV }, // live
        'src/svc/b.ts': { contentHash: contentHash(b), family: 'svc\x00typescript', deviations: DEV }, // live
        'src/svc/c.ts': { contentHash: 'STALE-hash-mismatch', family: 'svc\x00typescript', deviations: DEV }, // stale
      });

      const { status, stdout } = run(['advise'], dir);
      expect(status).toBe(0); // never gates (G4)

      const matches = [...stdout.matchAll(C8_RE)];
      expect(matches).toHaveLength(1); // ONE aggregate line, no per-file spam
      expect(Number(matches[0][1])).toBe(2); // stale entry excluded

      // The line lives in Attention (before Nominations), is a bare count, and never
      // names a file or a dimension — no per-file detail leaks into the feed.
      expect(stdout.indexOf('deviate structurally')).toBeLessThan(stdout.indexOf('Nominations'));
      expect(stdout).not.toContain('src/svc/a.ts');
      expect(stdout).not.toContain('branch-like');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2. omits the line for an empty index (no "0 files" noise), exit 0', () => {
    const dir = makeFixture('empty');
    try {
      gitInit(dir);
      writeIndex(dir, {});
      const { status, stdout } = run(['advise'], dir);
      expect(status).toBe(0);
      expect(stdout).not.toContain('deviate structurally');
      expect([...stdout.matchAll(C8_RE)]).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3. omits the line when there is no index file at all, exit 0', () => {
    const dir = makeFixture('absent');
    try {
      gitInit(dir);
      expect(existsSync(path.join(dir, INDEX_REL))).toBe(false);
      const { status, stdout } = run(['advise'], dir);
      expect(status).toBe(0);
      expect(stdout).not.toContain('deviate structurally');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4. omits the line when signals.attention is false, even with live entries (off-switch), exit 0', () => {
    const dir = makeFixture('off');
    try {
      gitInit(dir);
      seedTwoLiveEntries(dir);
      setSignalsAttention(dir, false);
      const { status, stdout } = run(['advise'], dir);
      expect(status).toBe(0); // never gates (G4)
      // The same off-switch that silences the per-file note in `yg context --file`
      // silences the aggregate that points there.
      expect(stdout).not.toContain('deviate structurally');
      expect([...stdout.matchAll(C8_RE)]).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5. shows the line when signals.attention is explicitly true, exit 0', () => {
    const dir = makeFixture('on');
    try {
      gitInit(dir);
      seedTwoLiveEntries(dir);
      setSignalsAttention(dir, true);
      const { status, stdout } = run(['advise'], dir);
      expect(status).toBe(0);
      const matches = [...stdout.matchAll(C8_RE)];
      expect(matches).toHaveLength(1); // explicit on keeps the C8 line
      expect(Number(matches[0][1])).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
