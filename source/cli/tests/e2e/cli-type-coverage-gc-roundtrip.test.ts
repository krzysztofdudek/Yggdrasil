// Flag disable/enable GC round-trip for a type-covered file's virtual
// verdict. Design: "flag-off pruning applies on the next FULL --approve —
// the --only-deterministic scoped writer never rewrites the committed
// lock." That committed-lock protection is specifically about the
// COMMITTED, non-deterministic (LLM) partition (yg-lock.nondeterministic.json)
// — the ONLY partition a scoped run must never touch on disk. A
// DETERMINISTIC entry lives in the gitignored .yg-lock.deterministic.json,
// which IS the file `--only-deterministic` owns and freely rewrites, so once
// the flag disables the type-level lattice (no nodeless pairs enter the
// expected universe at all), a deterministic virtual entry is positively
// detached and the scoped writer prunes it on its very next run — it does
// not wait for a full --approve. This suite pins that real, verified
// behavior for a deterministic entry, and the free re-fill on re-enabling.
//
// Real spawned binary, real on-disk fixture
// (tests/fixtures/type-coverage-graduation-twin/).
//
// HERMETIC: each test copies the fixture into its own mkdtemp directory —
// `yg check` writes derived state (lock files, AST cache, event log) into
// whatever directory it runs in, so running it against a fixture in place is
// never safe. Each copy is removed in its own afterEach, the directory that
// same test created and nothing else.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
  const dir = mkdtempSync(path.join(tmpdir(), `yg-gc-rt-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  activeDir = dir;
  return dir;
}

// Fill-progress lines (the "Filling N unverified pairs..." header and
// writePruneSummary's "Pruned..." lines) print to STDERR for a real
// --approve run (core/check.ts routes fill's own `write` sink to
// process.stderr.write there — only a --dry-run preview routes it to
// stdout instead). The final report (verdict, Type coverage, Errors/
// Warnings) always prints to stdout via formatOutput. `all` combines both
// so a caller checking for prune/fill wording does not have to track which
// stream a given line landed on.
function run(args: string[], dir: string): { code: number; stdout: string; stderr: string; all: string } {
  const r = spawnSync('node', [BIN, ...args], { cwd: dir, encoding: 'utf-8' });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { code: r.status ?? 1, stdout, stderr, all: stdout + stderr };
}

function setTypeLevel(dir: string, on: boolean): void {
  const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
  const cfg = readFileSync(cfgPath, 'utf-8').replace(
    /type_level:\s*(true|false)/,
    `type_level: ${on}`,
  );
  writeFileSync(cfgPath, cfg, 'utf-8');
}

describe('flag disable/enable GC round-trip for a deterministic virtual entry', () => {
  it('flag ON->OFF: the very next --only-deterministic run prunes the now-detached virtual entry, and says so — the scoped writer is free to rewrite its OWN gitignored partition; only the COMMITTED (LLM) partition is protected from a scoped run, which this deterministic-only fixture has none of', () => {
    const dir = copyFixture('off');
    const first = run(['check', '--approve', '--only-deterministic'], dir);
    expect(first.code).toBe(0);

    setTypeLevel(dir, false);

    const scoped = run(['check', '--approve', '--only-deterministic'], dir);
    expect(scoped.all).toMatch(/prune/i);
    expect(scoped.all).toMatch(/handler\.ts/);
    // The file has no other coverage mechanism in this fixture (no node maps
    // it), so once the type-level tier stops covering it, it is a genuine
    // blocking unmapped file — the correct, honest consequence of turning
    // coverage off for the only thing that covered it, not a bug.
    expect(scoped.code).toBe(1);
    expect(scoped.stdout).toMatch(/unmapped/i);

    // Nothing is left to prune on a subsequent full approve.
    const full = run(['check', '--approve'], dir);
    expect(full.all).not.toMatch(/prune/i);
  });

  it('flag OFF->ON round-trip: re-enabling reclassifies the same file to the same type and refills free — no phantom re-bill from the cycle alone', () => {
    const dir = copyFixture('on');
    const cfgPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
    const onCfg = readFileSync(cfgPath, 'utf-8');

    // ON: first fill.
    const first = run(['check', '--approve', '--only-deterministic'], dir);
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/handler\.ts/);

    // OFF, then a full approve to let the (accepted) prune actually happen.
    writeFileSync(cfgPath, onCfg.replace('type_level: true', 'type_level: false'));
    run(['check', '--approve'], dir);

    // Back ON: the file re-classifies to the SAME type against UNCHANGED
    // bytes, so its virtual verdict fills free again — a cycle that touches
    // neither the file nor the architecture must not manufacture extra cost
    // beyond this one, expected refill.
    writeFileSync(cfgPath, onCfg); // restore the original ON config verbatim
    const second = run(['check', '--approve', '--only-deterministic'], dir);
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/handler\.ts/);
    // Exactly one mention, not a count that grew from repeated cycling.
    expect((second.stdout.match(/handler\.ts/g) ?? []).length).toBe(1);
  });
});
