// =============================================================================
// CLI E2E — the advisory structural-attention line in `yg context --file` (RZ-21).
//
// Pins the public CLI surface (spawn the built bin.js). A file that is a structural
// OUTLIER among its node's other same-language files gets ONE plain-language note —
// but only when the local deviation index still describes its exact bytes, and only
// when the `signals.attention` off-switch is not set. Every scenario asserts exit 0
// (the note never blocks).
//
//   1. live outlier + index fresh          → the verbatim note prints
//   2. a NON-outlier sibling               → no note (control)
//   3. bytes mutated after the index wrote → no note (stale index stays silent)
//   4. signals.attention: false            → no note even on a live match (off-switch)
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

/** The verbatim advisory line (RZ-21). `<lang>` is the humanized family language. */
const ATTENTION_LINE =
  "This file is structurally unusual among this node's other TypeScript files — worth a closer read; no action required.";

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/** A TS file with `n` if-branches — varying `n` across a family makes one file a robust outlier. */
function tsFileWithIfs(n: number): string {
  const lines = ['export function f(): number {'];
  for (let i = 0; i < n; i++) lines.push(`  if (globalThis) { return ${i}; }`);
  lines.push('  return -1;');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/** One node owning six TypeScript files; file5 is a strong structural outlier (50 branches vs 1–3). */
function makeFixture(label: string, opts: { signalsOff?: boolean } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-ctx-attn-${label}-`));
  w(
    dir,
    '.yggdrasil/yg-architecture.yaml',
    `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
  );
  const signalsBlock = opts.signalsOff ? 'signals:\n  attention: false\n' : '';
  w(
    dir,
    '.yggdrasil/yg-config.yaml',
    `${signalsBlock}reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n`,
  );
  w(dir, '.yggdrasil/model/svc/yg-node.yaml', `name: Svc\ndescription: service unit\ntype: service\nmapping:\n  - src/svc\n`);
  [1, 2, 3, 2, 1, 50].forEach((n, i) => w(dir, `src/svc/file${i}.ts`, tsFileWithIfs(n)));
  return dir;
}

/**
 * A TYPE-COVERED variant of makeFixture: no node at all, just a non-strict
 * classifying type `svc` matching `src/svc/**` with `coverage.type_level: true` —
 * the SAME six-file branch-count pattern, so file5 is the identical outlier, but
 * every file is compared within its matched TYPE'S family, never a node's (there
 * is none to compare against here).
 */
function makeTypeCoveredFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-ctx-attn-typed-${label}-`));
  w(
    dir,
    '.yggdrasil/yg-architecture.yaml',
    `node_types:\n  svc:\n    description: 'a non-strict classifying type'\n    log_required: false\n    when:\n      path: "src/svc/**"\n`,
  );
  w(
    dir,
    '.yggdrasil/yg-config.yaml',
    `reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\ncoverage:\n  type_level: true\n`,
  );
  mkdirSync(path.join(dir, '.yggdrasil', 'model'), { recursive: true });
  [1, 2, 3, 2, 1, 50].forEach((n, i) => w(dir, `src/svc/file${i}.ts`, tsFileWithIfs(n)));
  return dir;
}

function gitInit(dir: string): void {
  const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
}

const INDEX_REL = path.join('.yggdrasil', '.feature-field.json');

describe.skipIf(!distExists)('CLI E2E — yg context --file advisory attention line', () => {
  it('1. prints the verbatim note for a live outlier (exit 0) and reads it back through the index', () => {
    const dir = makeFixture('live');
    try {
      gitInit(dir);
      const check = run(['check'], dir);
      expect(check.status).toBe(0);
      expect(existsSync(path.join(dir, INDEX_REL))).toBe(true);

      const ctx = run(['context', '--file', 'src/svc/file5.ts'], dir);
      expect(ctx.status).toBe(0); // never blocks
      expect(ctx.stdout).toContain(ATTENTION_LINE);
      // Plain language only — no stats jargon leaks into the note.
      expect(ctx.stdout.toLowerCase()).not.toContain('z-score');
      expect(ctx.stdout.toLowerCase()).not.toContain('deviation');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2. a NON-outlier sibling gets no note (control)', () => {
    const dir = makeFixture('control');
    try {
      gitInit(dir);
      expect(run(['check'], dir).status).toBe(0);

      const ctx = run(['context', '--file', 'src/svc/file0.ts'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).not.toContain('structurally unusual');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3. a stale index stays silent — mutating the bytes after the index wrote omits the note', () => {
    const dir = makeFixture('stale');
    try {
      gitInit(dir);
      expect(run(['check'], dir).status).toBe(0);
      // Confirm the note would show BEFORE the mutation.
      expect(run(['context', '--file', 'src/svc/file5.ts'], dir).stdout).toContain(ATTENTION_LINE);

      // Change the file's bytes WITHOUT re-running yg check — the index now points at stale bytes.
      appendFileSync(path.join(dir, 'src/svc/file5.ts'), '\n// a change the index has not seen\n');

      const ctx = run(['context', '--file', 'src/svc/file5.ts'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).not.toContain('structurally unusual');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4. signals.attention: false suppresses the note even on a live match (off-switch)', () => {
    const dir = makeFixture('offswitch', { signalsOff: true });
    try {
      gitInit(dir);
      expect(run(['check'], dir).status).toBe(0);
      // The index still recorded the outlier (writing is independent of the off-switch)…
      expect(existsSync(path.join(dir, INDEX_REL))).toBe(true);

      // …but the note is suppressed.
      const ctx = run(['context', '--file', 'src/svc/file5.ts'], dir);
      expect(ctx.status).toBe(0);
      expect(ctx.stdout).not.toContain('structurally unusual');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("5. a type-covered file (no owning node) names its matched TYPE, never a node, in the note", () => {
    const dir = makeTypeCoveredFixture('live');
    try {
      gitInit(dir);
      const check = run(['check'], dir);
      expect(check.status).toBe(0);

      const ctx = run(['context', '--file', 'src/svc/file5.ts'], dir);
      expect(ctx.status).toBe(0); // never blocks
      expect(ctx.stdout).toContain(
        "This file is structurally unusual among this file's matched type's other TypeScript files — worth a closer read; no action required.",
      );
      // Never claims a node owns the comparison — there is none in this fixture.
      expect(ctx.stdout).not.toContain("this node's other");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
