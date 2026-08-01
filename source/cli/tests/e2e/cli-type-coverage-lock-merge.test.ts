// Lock merge with virtual (type-covered) entries — the GIT-LEVEL companion to
// the unit-level merge-reconciliation tests elsewhere in this suite: it runs
// a REAL `git merge` in a REAL repository, the only place that proves git's
// actual line-diff algorithm resolves two independently-filled verdicts, not
// just that the CLI's own reconciliation logic is correct once handed an
// already-merged file.
//
// "Take-a-side" is a git-merge convention over the COMMITTED lock partition
// only: verdicts of LLM aspects live in yg-lock.nondeterministic.json, which
// IS committed and so IS the file a real git merge can conflict over. A
// deterministic aspect's verdicts live in the gitignored
// .yg-lock.deterministic.json — never committed, so a real git merge never
// even sees it (confirmed against this repo's own committed knowledge doc:
// "the gitignored cache never conflicts"). This fixture's classifying type
// therefore carries an LLM-reviewed rule as its actual subject; a second,
// deterministic rule on the same type demonstrates the other half of that
// same fact (its own gitignored verdicts never enter the merge at all). The
// LLM reviewer is an in-process mock speaking the real Ollama wire protocol
// (tests/e2e/support/mock-reviewer.ts) — the real HTTP/fill/hash code path
// runs end to end, with no dependency on a real model.
//
// Real spawned binary, real on-disk fixture
// (tests/fixtures/type-coverage-lock-merge-twin/), real `git`, PINNED to
// each throwaway fixture directory via tests/support/git-fixture.ts so a
// child `git` process can never discover or write to this repository's own
// `.git` (see that module's own doc for the two discovery vectors it
// closes).
//
// HERMETIC: every fixture copy here is a throwaway mkdtemp directory,
// removed in the same test's own `finally` — the directory that test
// created for itself and nothing else.
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { runGitFixture } from '../support/git-fixture.js';
import { startMockReviewer, runAsync, type MockReviewer } from './support/mock-reviewer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-coverage-lock-merge-twin');

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-lock-merge-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function pointReviewer(dir: string, mock: MockReviewer): void {
  const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  const cfg = readFileSync(cfgPath, 'utf-8').replace(
    /endpoint:\s*["']?[^"'\n]+["']?/,
    `endpoint: "${mock.endpoint}"`,
  );
  writeFileSync(cfgPath, cfg, 'utf-8');
}

function commitAll(dir: string, message: string): void {
  runGitFixture(dir, ['add', '-A']);
  runGitFixture(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message]);
}

function nondetLock(dir: string): { verdicts: Record<string, Record<string, unknown>> } {
  return JSON.parse(
    readFileSync(path.join(dir, '.yggdrasil', 'yg-lock.nondeterministic.json'), 'utf-8'),
  ) as { verdicts: Record<string, Record<string, unknown>> };
}

describe('lock merge with virtual entries (git-level)', () => {
  it('disjoint-key case: two branches each fill a DIFFERENT type-covered file — git line-merges cleanly, both verdicts survive self-validated', async () => {
    const dir = copyFixture('disjoint');
    const mock = await startMockReviewer();
    try {
      pointReviewer(dir, mock);
      runGitFixture(dir, ['init', '-q', '-b', 'main']);
      commitAll(dir, 'base');

      // Seed fill at the base, over the fixture's own two committed files
      // (svc-a.ts, svc-b.ts), so both lock partitions already contain
      // entries BEFORE any branch diverges — a git merge of a file that
      // does not exist yet on either side is an add/add conflict even for
      // disjoint content; merging into an already-tracked file with a
      // shared, unchanged anchor line is the clean case this test pins.
      const seed = await runAsync(['check', '--approve'], dir);
      expect(seed.status).toBe(0);
      commitAll(dir, 'seed fill');

      // Two NEW files, sorted OUTSIDE the [svc-a, svc-b] pair at both ends
      // (svc-0 < svc-a; svc-z > svc-b) — each branch's one new lock line
      // lands in its own diff hunk (never adjacent to a line the other
      // branch's insertion also touches), which is what makes the merge
      // clean rather than a same-position insertion conflict.
      runGitFixture(dir, ['checkout', '-q', '-b', 'branch-a']);
      writeFileSync(path.join(dir, 'src/svc/svc-0.ts'), 'export const zero = 0;\n');
      runGitFixture(dir, ['add', 'src/svc/svc-0.ts']);
      const fillA = await runAsync(['check', '--approve'], dir);
      expect(fillA.status).toBe(0);
      commitAll(dir, 'add+fill svc-0');

      runGitFixture(dir, ['checkout', '-q', 'main']);
      runGitFixture(dir, ['checkout', '-q', '-b', 'branch-b']);
      writeFileSync(path.join(dir, 'src/svc/svc-z.ts'), 'export const z = 0;\n');
      runGitFixture(dir, ['add', 'src/svc/svc-z.ts']);
      const fillB = await runAsync(['check', '--approve'], dir);
      expect(fillB.status).toBe(0);
      commitAll(dir, 'add+fill svc-z');

      runGitFixture(dir, ['checkout', '-q', 'branch-a']);
      const mergeResult = runGitFixture(dir, ['merge', '-q', '--no-edit', 'branch-b']);
      expect(mergeResult.status).toBe(0); // clean merge — no conflict markers

      // All four files' verdicts survived the merge, self-validated.
      const lock = nondetLock(dir);
      expect(Object.keys(lock.verdicts['svc-review']).sort()).toEqual([
        'file:src/svc/svc-0.ts',
        'file:src/svc/svc-a.ts',
        'file:src/svc/svc-b.ts',
        'file:src/svc/svc-z.ts',
      ]);

      // Re-running reports zero NEW reviewer calls — every entry already
      // holds a valid verdict for the file it names.
      const after = await runAsync(['check', '--approve'], dir);
      expect(after.status).toBe(0);
      expect(after.all).toMatch(/0 reviewer calls made/);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('same-key case: a genuine content conflict on the SAME file resolves by taking one side, then --approve reconciles cleanly with no new bill', async () => {
    const dir = copyFixture('conflict');
    const mock = await startMockReviewer();
    try {
      pointReviewer(dir, mock);
      runGitFixture(dir, ['init', '-q', '-b', 'main']);
      commitAll(dir, 'base');

      runGitFixture(dir, ['checkout', '-q', '-b', 'branch-a']);
      writeFileSync(path.join(dir, 'src/svc/svc-a.ts'), '// variant A\nexport const a = 1;\n');
      const fillA = await runAsync(['check', '--approve'], dir);
      expect(fillA.status).toBe(0);
      commitAll(dir, 'variant A');

      runGitFixture(dir, ['checkout', '-q', 'main']);
      runGitFixture(dir, ['checkout', '-q', '-b', 'branch-b']);
      writeFileSync(path.join(dir, 'src/svc/svc-a.ts'), '// variant B\nexport const a = 2;\n');
      const fillB = await runAsync(['check', '--approve'], dir);
      expect(fillB.status).toBe(0);
      commitAll(dir, 'variant B');

      runGitFixture(dir, ['checkout', '-q', 'branch-a']);
      const mergeResult = runGitFixture(dir, ['merge', '-q', '--no-edit', 'branch-b']);
      expect(mergeResult.status).not.toBe(0); // a REAL conflict: source and its lock entry both diverge

      // Take a side: keep branch-a's version of both the source and its
      // committed lock entry (the gitignored deterministic file is never
      // part of the conflict at all — nothing to resolve there).
      runGitFixture(dir, ['checkout', '--ours', '--', 'src/svc/svc-a.ts']);
      runGitFixture(dir, ['checkout', '--ours', '--', '.yggdrasil/yg-lock.nondeterministic.json']);
      commitAll(dir, 'resolve: keep branch-a');

      // Reconciliation: the surviving entry's hash still matches the file
      // on disk (branch-a's content) — a clean pass with zero new bill.
      const after = await runAsync(['check', '--approve'], dir);
      expect(after.status).toBe(0);
      expect(after.all).toMatch(/0 reviewer calls made/);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
