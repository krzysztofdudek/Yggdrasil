// =============================================================================
// CLI E2E — the NOISE-FLOOR line `yg check` owes a repository that has just
// switched a graph on, driven through the real built binary.
//
// A mined graph arrives with a fixed population of refusals standing on code
// nobody in the current change wrote. Every run lists them; nothing said what
// they ARE, so each reader either derived "this is the floor, not my doing" or
// read the report as a verdict on their own work.
//
// The line is not an issue: it is never counted, never changes an exit code,
// and says nothing at all when nothing is standing there.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgressiveFixture, type ProgressiveFixture } from '../support/progressive-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

const fixtures: ProgressiveFixture[] = [];

afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

function run(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The verbatim tail every noise-floor line ends with. */
const BASELINE_TAIL =
  'on code this change did not touch — that is the baseline this repository already had, not a result of your change.';

describe.skipIf(!distExists)('CLI E2E — the noise-floor line', () => {
  it('names the advisory refusals standing on code the change never touched', () => {
    // `beta` carries the standing refusal; the rule only warns, so it is never
    // re-coded by the scope classification and nothing else in the report can
    // say it is not this change's doing.
    const fx = createProgressiveFixture({
      label: 'noise-advisory',
      progressiveReference: 'main',
      deterministicAspectStatus: 'advisory',
    });
    fixtures.push(fx);

    // Record the verdicts on the reference itself, so the refusal is standing
    // before the branch exists at all.
    expect(run(['check', '--approve', '--only-deterministic'], fx.dir).status).toBe(0);
    fx.branchWithEdit('work', 'src/alpha/alpha.ts', 'export const alpha = 42;\n');

    const { status, stdout } = run(['check'], fx.dir);
    expect(status).toBe(0); // an advisory refusal never blocks
    expect(stdout).toContain(`1 advisory refusal stands ${BASELINE_TAIL}`);
  });

  it('says nothing when the change reaches the refusing code itself', () => {
    const fx = createProgressiveFixture({
      label: 'noise-touched',
      progressiveReference: 'main',
      deterministicAspectStatus: 'advisory',
    });
    fixtures.push(fx);
    expect(run(['check', '--approve', '--only-deterministic'], fx.dir).status).toBe(0);
    // The branch edits the very file the refusal is about — the finding is now
    // the change's own business, and no floor is left to name.
    fx.branchWithEdit('work', 'src/beta/beta.ts', '// TODO: still broken, and now on purpose here.\nexport const beta = 3;\n');
    expect(run(['check', '--approve', '--only-deterministic'], fx.dir).status).toBe(0);

    const { stdout } = run(['check'], fx.dir);
    expect(stdout).not.toContain(BASELINE_TAIL);
  });

  it('counts an enforced finding held outside the change alongside the advisory ones', () => {
    const fx = createProgressiveFixture({
      label: 'noise-enforced',
      progressiveReference: 'main',
      // Default status: `beta`'s standing refusal BLOCKS, so a measured run
      // holds it outside the change instead of dropping it.
    });
    fixtures.push(fx);
    // On the reference branch itself there is no change, so the refusal is
    // already held outside it and the recording run passes.
    expect(run(['check', '--approve', '--only-deterministic'], fx.dir).status).toBe(0);
    fx.branchWithEdit('work', 'src/alpha/alpha.ts', 'export const alpha = 42;\n');
    // The edit put alpha's own verdict out of date; record it so the only thing
    // left in the report is the finding this run inherited.
    expect(run(['check', '--approve', '--only-deterministic'], fx.dir).status).toBe(0);

    const { status, stdout } = run(['check'], fx.dir);
    expect(status).toBe(0); // held outside the change, so it does not block
    expect(stdout).toContain(`1 enforced finding held outside it stands ${BASELINE_TAIL}`);
  });

  it('says nothing at all on a project that measures nothing', () => {
    // No reference branch: there is no "code this change did not touch" to
    // speak of, and inventing one would be a claim the run cannot support.
    const fx = createProgressiveFixture({ label: 'noise-unmeasured', deterministicAspectStatus: 'advisory' });
    fixtures.push(fx);
    expect(run(['check', '--approve', '--only-deterministic'], fx.dir).status).toBe(0);

    const { stdout } = run(['check'], fx.dir);
    expect(stdout).toContain('yg check:');
    expect(stdout).not.toContain(BASELINE_TAIL);
  });
});
