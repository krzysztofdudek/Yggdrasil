// =============================================================================
// E2E — a relations: atom inside an aspect's applicability predicate (`when:`)
// must be answered from a type-covered file's REAL, statically-resolved
// imports, not a phantom index that always reads false.
//
// tests/unit/core/type-effective.test.ts already proves the predicate's OWN
// logic against a hand-built TypedEdgeIndex passed directly into
// computeTypeAspectCascade — but nothing drives that index through the real
// CLI: real source, a real parse, a real resolved import. This suite closes
// that gap, spawning the built binary against the REAL committed
// tests/fixtures/type-level-engine/ project merged with its `live-relations`
// variant (see that variant's README): consumer/c.ts imports a real
// leaf-typed file; consumer/plain.ts imports nothing. Every aspect involved
// is deterministic (free, keyless) — no mock reviewer needed.
//
// Three commands answer this atom for the same file — `yg check`, `yg
// context --file`, and `yg owner --file` — and this suite also asserts they
// agree: a single-file preview naming a different rule set than what `yg
// check` actually verified would send an agent to satisfy a rule that is not
// enforced, or leave one unaddressed that is.
//
// HERMETIC: fresh mkdtemp merge (base + variant) per test, rmSync'd in
// finally. No network, no clock.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLock } from './support/read-lock.js';
import { FIXTURE_LIVE_RELATIONS } from '../fixtures/type-level-engine/variants/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const BASE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, status: result.status, all: stdout + stderr };
}

function copyMergedFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-live-relations-'));
  cpSync(BASE_FIXTURE, dir, { recursive: true });
  cpSync(FIXTURE_LIVE_RELATIONS, dir, { recursive: true });
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — a relations: atom answered from a real import', () => {
  it('a positively-gated rule attaches to a file whose real import satisfies the atom', () => {
    const dir = copyMergedFixture();
    try {
      run(['check', '--approve', '--only-deterministic'], dir);
      const lock = readLock(path.join(dir, '.yggdrasil'));
      // c.ts imports src/leaf/a.ts (a leaf-typed target) — needs-leaf-dependency
      // (when: { relations: { uses: { target_type: leaf } } }) must attach and,
      // since its check.mjs always approves, be recorded as verified.
      expect(lock.verdicts['needs-leaf-dependency']?.['file:src/consumer/c.ts']?.verdict).toBe('approved');
      // plain.ts imports nothing — the SAME rule must not attach there.
      expect(lock.verdicts['needs-leaf-dependency']?.['file:src/consumer/plain.ts']).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('the negated counterpart of that gate does not attach where the positive gate does, and does attach where it does not', () => {
    const dir = copyMergedFixture();
    try {
      run(['check', '--approve', '--only-deterministic'], dir);
      const lock = readLock(path.join(dir, '.yggdrasil'));
      // never-imports-leaf (when: { not: { relations: { uses: { target_type: leaf } } } })
      // is the negated mirror of needs-leaf-dependency: it must NOT attach to
      // c.ts, which DOES import a leaf file...
      expect(lock.verdicts['never-imports-leaf']?.['file:src/consumer/c.ts']).toBeUndefined();
      // ...and MUST attach to plain.ts, which imports nothing.
      expect(lock.verdicts['never-imports-leaf']?.['file:src/consumer/plain.ts']?.verdict).toBe('approved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('a read-only check and the approval path agree on which relations-gated pairs apply to a file', () => {
    const dir = copyMergedFixture();
    try {
      // BEFORE any fill: a plain read-only check must already recognize
      // needs-leaf-dependency as expected-but-unverified on c.ts (its real
      // import satisfies the atom), and must NOT expect never-imports-leaf
      // there (the negated atom is not satisfied) — the read path's own pair
      // computation, independent of whatever the approval path later writes.
      const before = run(['check'], dir);
      expect(before.all).toMatch(/^ {12}- src\/consumer\/c\.ts {2}aspect 'needs-leaf-dependency'$/m);
      expect(before.all).not.toMatch(/^ {12}- src\/consumer\/c\.ts {2}aspect 'never-imports-leaf'$/m);

      // The approval path must fill exactly the pair the read path expected.
      run(['check', '--approve', '--only-deterministic'], dir);
      const lock = readLock(path.join(dir, '.yggdrasil'));
      expect(lock.verdicts['needs-leaf-dependency']?.['file:src/consumer/c.ts']?.verdict).toBe('approved');
      expect(lock.verdicts['never-imports-leaf']?.['file:src/consumer/c.ts']).toBeUndefined();

      // AFTER filling: a fresh read-only check must now consider that exact
      // pair verified — no lingering disagreement between what the approval
      // path wrote and what a later read expects.
      const after = run(['check'], dir);
      expect(after.all).not.toMatch(/src\/consumer\/c\.ts {2}aspect 'needs-leaf-dependency'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('yg context --file names the same enforced rule yg check just verified for a file whose import satisfies the atom', () => {
    const dir = copyMergedFixture();
    try {
      run(['check', '--approve', '--only-deterministic'], dir);
      const contextOut = run(['context', '--file', 'src/consumer/c.ts'], dir);
      // c.ts imports a leaf file: needs-leaf-dependency must be listed under
      // "Must satisfy:" and, since the approval run above just recorded its
      // verdict, carry no unverified caveat. never-imports-leaf, the negated
      // mirror, must not be listed at all — the approval run never attached
      // it here, so a preview that still showed it would be naming a rule
      // yg check does not enforce.
      expect(contextOut.all).toMatch(/^ {4}needs-leaf-dependency \[enforced\] —/m);
      expect(contextOut.all).not.toMatch(/^ {4}never-imports-leaf \[/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('yg context --file names the negated rule for the mirror file whose import does not satisfy the atom', () => {
    const dir = copyMergedFixture();
    try {
      run(['check', '--approve', '--only-deterministic'], dir);
      const contextOut = run(['context', '--file', 'src/consumer/plain.ts'], dir);
      // plain.ts imports nothing: never-imports-leaf must be listed under
      // "Must satisfy:" with no unverified caveat; needs-leaf-dependency, the
      // positive gate, must not be listed at all.
      expect(contextOut.all).toMatch(/^ {4}never-imports-leaf \[enforced\] —/m);
      expect(contextOut.all).not.toMatch(/^ {4}needs-leaf-dependency \[/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('yg owner --file agrees with the filled lock on a file whose import satisfies the atom, leaving nothing unverified', () => {
    const dir = copyMergedFixture();
    try {
      run(['check', '--approve', '--only-deterministic'], dir);
      const ownerOut = run(['owner', '--file', 'src/consumer/c.ts'], dir);
      // Every rule owner --file expects for this file was just filled by the
      // approval run above, resolving the SAME real import — no caveat
      // should appear. Before this file's own imports were resolved the same
      // way, owner --file expected never-imports-leaf here too (the negated
      // atom read true with no edge index), a rule the approval run never
      // filled, so the caveat would have named it unverified.
      expect(ownerOut.all).toContain('Enforced by its architecture type, not by a component.');
      expect(ownerOut.all).not.toMatch(/unverified/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('yg owner --file agrees with the filled lock on the mirror file whose import does not satisfy the atom, leaving nothing unverified', () => {
    const dir = copyMergedFixture();
    try {
      run(['check', '--approve', '--only-deterministic'], dir);
      const ownerOut = run(['owner', '--file', 'src/consumer/plain.ts'], dir);
      expect(ownerOut.all).toContain('Enforced by its architecture type, not by a component.');
      expect(ownerOut.all).not.toMatch(/unverified/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
