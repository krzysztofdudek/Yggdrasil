// "Graduation": a file starts type-covered (a virtual file:<path> unit), then
// an explicit node claims it — the same subject file, the same rule, the
// same unit key. Pins:
// (1) the pair's STORED HASH CHANGES across graduation (the canonical input's
//     `node:` field goes from absent to present) — the one sanctioned
//     re-bill class, not a defect;
// (2) the SAME unit key (file:<path>) is reused, not re-keyed — a plain
//     `yg check` right after graduation shows the pair UNVERIFIED (visible,
//     never a silent pass on a stale verdict), and the next free
//     `--only-deterministic` run re-fills it under that identical key, once;
// (3) this is NOT a garbage-collection event — GC prunes only entries whose
//     (aspectId, unitKey) pair has left the expected universe entirely;
//     graduation keeps the same key in the universe (now attributed to the
//     claiming node), so no "Pruned" line is ever printed for it.
//
// Real spawned binary, real on-disk fixture
// (tests/fixtures/type-coverage-graduation-twin/): one non-strict type
// (svc), one free deterministic aspect, one cleanly-matching file
// (src/svc/handler.ts). Each test's mkdtemp copy is removed in its own
// afterEach — the directory a test creates for itself and nothing else.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-coverage-graduation-twin');

let activeDir: string | undefined;
afterEach(() => {
  if (activeDir) rmSync(activeDir, { recursive: true, force: true });
  activeDir = undefined;
});

function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-grad-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  activeDir = dir;
  return dir;
}

function run(args: string[], dir: string): { code: number; stdout: string } {
  const r = spawnSync('node', [BIN, ...args], { cwd: dir, encoding: 'utf-8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '' };
}

function detLockJson(dir: string): { verdicts: Record<string, Record<string, { hash: string }>> } {
  const raw = readFileSync(path.join(dir, '.yggdrasil', '.yg-lock.deterministic.json'), 'utf-8');
  return JSON.parse(raw) as { verdicts: Record<string, Record<string, { hash: string }>> };
}

describe('graduation twin: type-covered file -> explicit node, same file, same rule', () => {
  it('pre-graduation: the file:<path> virtual verdict fills free (deterministic, no LLM)', () => {
    const dir = copyFixture('pre');
    const before = run(['check', '--approve', '--only-deterministic'], dir);
    expect(before.code).toBe(0);
    const lock = detLockJson(dir);
    expect(Object.keys(lock.verdicts['svc-file-shape'])).toEqual(['file:src/svc/handler.ts']);
  });

  it('post-graduation: an explicit node claiming the SAME file re-verifies under the SAME unit key, with a DIFFERENT stored hash (node: now present in the canonical) — visible as an ordinary unverified pair, not silent', () => {
    const dir = copyFixture('post');
    run(['check', '--approve', '--only-deterministic'], dir);
    const beforeHash = detLockJson(dir).verdicts['svc-file-shape']['file:src/svc/handler.ts'].hash;

    // Graduate: an explicit node claims the file the type already covered.
    // The node directory is FLAT (model/handler/, not model/svc/handler/) —
    // graph-loader's model walk only descends past a directory that itself
    // carries a yg-node.yaml, so an intermediate directory without one (e.g.
    // a "svc/" grouping folder) would silently stop the walk one level too
    // early and the node would never load at all.
    mkdirSync(path.join(dir, '.yggdrasil', 'model', 'handler'), { recursive: true });
    writeFileSync(
      path.join(dir, '.yggdrasil', 'model', 'handler', 'yg-node.yaml'),
      'name: Handler\ntype: svc\ndescription: "Graduated from type-level coverage."\nmapping:\n  - src/svc/handler.ts\n',
    );

    // A plain check right after graduation shows the pair UNVERIFIED — the
    // stored verdict's hash no longer matches the freshly-computed one
    // (node: now folds into the canonical input) — visible, not a silent
    // stale PASS.
    const plain = run(['check'], dir);
    expect(plain.code).toBe(1);
    expect(plain.stdout).toMatch(/unverified/i);
    expect(plain.stdout).toMatch(/handler/);
    // Never a "Pruned" line: this is a hash mismatch under the SAME
    // (aspectId, unitKey) pair, still in the expected universe (now
    // attributed to the claiming node) — not a detachment GC would prune.
    expect(plain.stdout).not.toMatch(/prune/i);

    // The next free deterministic run re-fills it, once, under the
    // IDENTICAL unit key — same key, new fingerprint, not a new entry.
    const after = run(['check', '--approve', '--only-deterministic'], dir);
    expect(after.code).toBe(0);
    expect(after.stdout).not.toMatch(/prune/i);
    const afterLock = detLockJson(dir);
    expect(Object.keys(afterLock.verdicts['svc-file-shape'])).toEqual(['file:src/svc/handler.ts']);
    expect(afterLock.verdicts['svc-file-shape']['file:src/svc/handler.ts'].hash).not.toBe(beforeHash);
  });
});
