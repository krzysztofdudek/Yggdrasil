// =============================================================================
// CLI E2E — a reasonless yg-suppress marker fails only what it would waive.
//
// A marker with no reason waives nothing. What it fails is the pair it would
// have waived: a violation of an aspect it names, on a line in its range — or,
// for a reviewer rule, a pair of an aspect it names. A marker naming another
// aspect (here one that does not exist) leaves every other rule of the file
// judged normally, and every reviewer prompt of another rule assembles.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectIssue, findIssues, parseJson } from '../support/assert-output.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const LIFECYCLE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

function yg(dir: string, args: string[]): { status: number | null; stdout: string; all: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd: dir, encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } });
  return { status: r.status, stdout: r.stdout ?? '', all: (r.stdout ?? '') + (r.stderr ?? '') };
}

const ORDERS = path.join('src', 'services', 'orders.ts');

describe.skipIf(!distExists)('CLI E2E — a reasonless suppress marker fails only what it would waive', () => {
  it('a marker naming another aspect leaves the file’s script rules judged and its reviewer prompts assembled', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-suppress-scope-'));
    try {
      cpSync(LIFECYCLE, dir, { recursive: true });
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      // A violation of no-todo-comments on line 1, and a reasonless marker for
      // an aspect that is not this one, far from it.
      const file = path.join(dir, ORDERS);
      writeFileSync(file, `// TODO: split this service\n${readFileSync(file, 'utf-8')}`);
      appendFileSync(file, '\n// yg-suppress(zzz)\nexport const tail = 1;\n');
      const fill = yg(dir, ['check', '--approve', '--only-deterministic', '--json']);
      const doc = parseJson(fill.stdout);
      // Judged: the TODO is refused, not left unverified over the marker.
      expectIssue(doc, { code: 'aspect-violation-enforced', aspect: 'no-todo-comments', node: 'services/orders' });
      expect(findIssues(doc, { code: 'unverified', aspect: 'no-todo-comments' })).toEqual([]);
      // The reviewer rule's prompt for the same file assembles.
      const preview = yg(dir, ['aspect-test', '--aspect', 'has-doc-comment', '--node', 'services/orders', '--dry-run']);
      expect(preview.status, preview.all).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
