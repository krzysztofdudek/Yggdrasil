// =============================================================================
// GUARD — no new end-to-end assertion pins a sentence of CLI prose.
//
// An end-to-end test that asserts `toContain('<a sentence of the report>')`
// breaks on every rewording of that sentence, though the behaviour it checks
// did not change; hundreds of such assertions are why each wording change of
// the output had to touch tests across the tree. A behaviour test asserts on
// the issue code, the block label, the verdict line or a JSON field instead
// (tests/support/assert-output.ts); the exact words live in the golden corpus.
//
// The assertions already written are counted per file in
// e2e-prose-baseline.json. This guard fails when a file holds MORE prose
// assertions than its baseline (a file not listed has a baseline of 0), naming
// each one with its line. It also fails when a file holds FEWER, so a
// conversion lowers the baseline in the same change and the count only goes
// down: `npm run prose:baseline` (YG_PROSE_BASELINE_UPDATE=1) rewrites the
// file with every count lowered to what is there now, and never raises one.
//
// Files where the wording IS the contract under test are listed in
// WORDING_CONTRACT below and are not counted. Raising a baseline by hand is
// possible, and shows in review as exactly that.
//
// Hermetic & fast: reads files, spawns nothing.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProseAssertions, PROSE_MIN_WORDS } from '../../support/prose-assertions.js';
import {
  expectBlock,
  expectIssue,
  expectNext,
  expectNoIssue,
  expectVerdict,
  errorCodes,
  findIssues,
  nextCommand,
  textBlocks,
  textNext,
  verdictLine,
  type OutputDoc,
} from '../../support/assert-output.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTS_ROOT = path.resolve(__dirname, '..', '..');
const E2E_ROOT = path.join(TESTS_ROOT, 'e2e');
const BASELINE_PATH = path.join(__dirname, 'e2e-prose-baseline.json');

/**
 * End-to-end files whose subject is the wording itself, so a sentence is the
 * right thing to assert: the golden corpus comparison, and the docs samples
 * that must match a real run character for character.
 */
const WORDING_CONTRACT = new Set(['cli-golden-corpus.test.ts', 'docs-output-samples.test.ts']);

interface Baseline {
  description: string;
  files: Record<string, number>;
}

function e2eTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) e2eTestFiles(p, out);
    else if (entry.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

function currentCounts(): Map<string, { count: number; lines: string[] }> {
  const counts = new Map<string, { count: number; lines: string[] }>();
  for (const file of e2eTestFiles(E2E_ROOT).sort()) {
    const rel = path.relative(E2E_ROOT, file).split(path.sep).join('/');
    if (WORDING_CONTRACT.has(rel)) continue;
    const found = findProseAssertions(readFileSync(file, 'utf-8'));
    if (found.length === 0) continue;
    counts.set(rel, { count: found.length, lines: found.map((f) => `  ${rel}:${f.line}  ${f.matcher}(${JSON.stringify(f.literal)})`) });
  }
  return counts;
}

function readBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as Baseline;
}

describe('prose assertion scanner', () => {
  it('counts a string, template or regular expression literal of five or more words', () => {
    const src = [
      "expect(a).toContain('the file is not covered by any node');",
      'expect(a).toMatch(/^error\\[unverified\\] \\d+ pairs? whose inputs changed since the verdict$/m);',
      'expect(a).not.toContain(`no reviewer is ${x} configured for this`);',
    ].join('\n');
    const found = findProseAssertions(src);
    expect(found.map((f) => f.line)).toEqual([1, 2, 3]);
    expect(found.every((f) => f.words >= PROSE_MIN_WORDS)).toBe(true);
  });

  it('does not count a token, a command with its flags, or a literal built from a variable', () => {
    const src = [
      "expect(a).toContain('config-reviewer-missing');",
      "expect(a).toContain('yg check --approve --only-deterministic --json');",
      "expect(a).toBe('yg log merge-resolve --node services/payments');",
      'expect(a).toContain(message);',
      "expect(a).toEqual(['one', 'two', 'three', 'four', 'five']);",
    ].join('\n');
    expect(findProseAssertions(src)).toEqual([]);
  });
});

describe('assert-output helpers', () => {
  const doc: OutputDoc = {
    issues: [
      { code: 'unverified', severity: 'error', cause: 'stale', node: 'a' },
      { code: 'yaml-invalid', severity: 'error', node: 'b' },
    ],
    next: { command: ['yg', 'log', 'merge-resolve', '--node', 'a'], requiresUser: false, target: { node: 'a' } },
  };

  it('match issues on their fields and name what is there when nothing matches', () => {
    expect(expectIssue(doc, { code: 'unverified', cause: 'stale' }).node).toBe('a');
    expect(findIssues(doc, { severity: 'error' })).toHaveLength(2);
    expectNoIssue(doc, { code: 'unverified', cause: 'deterministic-not-run' });
    expect(() => expectIssue(doc, { code: 'orphaned-aspect' })).toThrow(/unverified\/stale @a/);
  });

  it('read next as one command string', () => {
    expect(nextCommand(doc)).toBe('yg log merge-resolve --node a');
    expectNext(doc, { command: 'yg log merge-resolve --node a', requiresUser: false, node: 'a' });
    expect(nextCommand({ next: { command: null } })).toBeNull();
  });

  it('read the text report structure: blocks, verdict line, next command, error codes', () => {
    const text = [
      'yg check: FAIL  5 errors in 2 blocks · 1 warning   3 nodes',
      '',
      'error[unverified] 2 pairs whose inputs changed',
      'warning[uncovered] 1 file',
      '',
      'next: yg check --approve --only-deterministic  (2 script pairs · free)',
    ].join('\n');
    expect(textBlocks(text).map((b) => `${b.severity}[${b.label}]`)).toEqual(['error[unverified]', 'warning[uncovered]']);
    expectBlock(text, { label: 'uncovered', severity: 'warning' });
    expect(verdictLine(text)).toEqual({ status: 'FAIL', errors: 5, warnings: 1 });
    expectVerdict(text, { status: 'FAIL', errors: 5 });
    expect(textNext(text)).toBe('yg check --approve --only-deterministic');
    expect(errorCodes('error[usage]: --top expects a number\n')).toEqual(['usage']);
    expect(textBlocks('error[usage]: --top expects a number\n')).toEqual([]);
  });
});

describe('end-to-end prose assertions only go down', () => {
  it('no file holds more prose assertions than its baseline, and the baseline is not stale', () => {
    const counts = currentCounts();
    // As glossary:update does for its page: the update writes first, and the
    // same assertions below then run against what it wrote. It only ever lowers
    // a count, so a file over its baseline still fails with the update on.
    if (process.env.YG_PROSE_BASELINE_UPDATE === '1') {
      const before = readBaseline();
      const lowered: Record<string, number> = {};
      for (const [rel, allowed] of Object.entries(before.files)) {
        const now = counts.get(rel)?.count ?? 0;
        if (now > 0) lowered[rel] = Math.min(now, allowed);
      }
      writeFileSync(BASELINE_PATH, `${JSON.stringify({ description: before.description, files: lowered }, null, 2)}\n`, 'utf-8');
    }
    const baseline = readBaseline();

    // A file renamed with its assertions unchanged shows up as a new file over a
    // baseline of 0, and its old name as a listed file that is gone. The guard
    // cannot tell a rename from a new file without asking git, so it names the
    // gone entries: moving the count to the new name is a one-key edit of the
    // baseline, visible in review as exactly that.
    const gone = Object.keys(baseline.files).filter((rel) => !counts.has(rel) && !existsSync(path.join(E2E_ROOT, rel)));
    const over: string[] = [];
    for (const [rel, { count, lines }] of counts) {
      const allowed = baseline.files[rel] ?? 0;
      if (count <= allowed) continue;
      const renamed = allowed === 0 && gone.length > 0
        ? `\n  If ${rel} is a renamed file, rename its baseline key: the baseline still lists ${gone.join(', ')}, which no longer exist.`
        : '';
      over.push(`${rel}: ${count} prose assertions, baseline ${allowed}${renamed}\n${lines.join('\n')}`);
    }
    expect(
      over,
      'An end-to-end test asserts on a sentence of CLI output. Assert on the issue code, block label, verdict line ' +
        'or a JSON field instead (tests/support/assert-output.ts); the exact wording belongs in the golden corpus. ' +
        'If the wording itself is what the file tests, add the file to WORDING_CONTRACT in this guard.',
    ).toEqual([]);

    const stale: string[] = [];
    for (const [rel, allowed] of Object.entries(baseline.files)) {
      const now = counts.get(rel)?.count ?? 0;
      if (now < allowed) stale.push(`${rel}: baseline ${allowed}, now ${now}`);
    }
    expect(stale, 'Prose assertions were removed; lower the baseline with npm run prose:baseline.').toEqual([]);
  });
});
