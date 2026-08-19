import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildGoldenRepo, assertGoldenBundleEquivalence, type GoldenRepoSpec } from '../../support/roots-golden.js';
import { runGitFixture } from '../../support/git-fixture.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/roots-golden.test.ts — the round-trip proof for
// tests/support/roots-golden.ts's own two exports: `buildGoldenRepo` and
// `assertGoldenBundleEquivalence` are otherwise exercised only INDIRECTLY
// (via git-fixture-determinism.test.ts, which proves the deterministic
// primitives underneath them) — tests/support/** carries no coverage gate of
// its own, so this file is what actually calls the harness end to end:
// without it, nothing in this repository proves that a golden bundle built
// from a spec and then checked against that spec actually round-trips, or
// that a genuinely drifted spec is caught rather than silently accepted.
//
// Two things are proven:
//   1. THE HAPPY PATH — a spec built once, bundled with a real
//      `git bundle create --all`, and checked against `assertGoldenBundleEquivalence`
//      using THAT SAME spec passes cleanly (no throw). This is the
//      builder-and-checker round trip the module's own header comment
//      describes.
//   2. DRIFT DETECTION — mutating one file's content in the spec (without
//      touching the bundle) makes the same check THROW, and throw with the
//      specific "HEAD sha mismatch" diagnostic naming both SHAs and the
//      golden's name — not a generic "git ... failed in ..." message, which
//      is what a HARNESS failure (a broken git invocation, a bad path) would
//      produce instead. Asserting the message shape is what keeps this test
//      from passing for the wrong reason: a rewrite that made
//      assertGoldenBundleEquivalence throw on ANY internal error, drift or
//      not, would still make the bare "did it throw" half of this test pass.
// ---------------------------------------------------------------------------

const dirsToCleanup: string[] = [];
afterEach(() => {
  for (const d of dirsToCleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function baseSpec(name: string): GoldenRepoSpec {
  return {
    name,
    commits: [
      { author: 'alice', files: { 'a.txt': 'first\n' }, message: 'first commit' },
      { author: 'bob', files: { 'b.txt': 'second\n' }, message: 'second commit' },
    ],
  };
}

/** `git bundle create --all` from `dir` into a fresh temp file; returns the bundle's absolute path. */
function bundleAll(dir: string, name: string): string {
  const bundleDir = mkdtempSync(path.join(tmpdir(), `yg-golden-bundle-${name}-`));
  dirsToCleanup.push(bundleDir);
  const bundlePath = path.join(bundleDir, `${name}.bundle`);
  const r = runGitFixture(dir, ['bundle', 'create', bundlePath, '--all']);
  if (r.status !== 0) throw new Error(`git bundle create failed in ${dir}: ${r.stderr}${r.stdout}`);
  return bundlePath;
}

describe('roots-golden — round-trip proof: buildGoldenRepo <-> git bundle <-> assertGoldenBundleEquivalence', () => {
  it('a fresh bundle built from a spec is asserted equivalent to that same spec (happy path passes)', () => {
    const spec = baseSpec('roundtrip-pass');
    const built = buildGoldenRepo(spec);
    dirsToCleanup.push(built);

    const bundlePath = bundleAll(built, spec.name);

    expect(() => assertGoldenBundleEquivalence(spec, bundlePath)).not.toThrow();
  });

  it('a spec that has drifted from the committed bundle throws the HEAD-sha drift diagnostic, not a generic harness-failure message', () => {
    const spec = baseSpec('roundtrip-drift');
    const built = buildGoldenRepo(spec);
    dirsToCleanup.push(built);

    const bundlePath = bundleAll(built, spec.name);

    // Mutate: change one file's content in the LAST commit only. The bundle
    // above still holds the ORIGINAL history — spec and bundle now describe
    // two different repositories, which is exactly the drift this checker
    // exists to catch.
    const lastIndex = spec.commits.length - 1;
    const driftedSpec: GoldenRepoSpec = {
      ...spec,
      commits: spec.commits.map((commit, index) =>
        index === lastIndex ? { ...commit, files: { ...commit.files, 'b.txt': 'second, mutated\n' } } : commit,
      ),
    };

    let thrown: unknown;
    try {
      assertGoldenBundleEquivalence(driftedSpec, bundlePath);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // The specific drift diagnostic: names the golden and says "stale",
    // distinct from the generic "git <cmd> failed in <dir>: ..." shape every
    // OTHER error path in roots-golden.ts throws on a real harness failure
    // (a bad git invocation, a missing bundle file, etc).
    expect(message).toContain(`golden "${spec.name}"`);
    expect(message).toContain('HEAD sha mismatch');
    expect(message).toContain('stale');
    expect(message).not.toMatch(/^git .+ failed in/);
  });
});
