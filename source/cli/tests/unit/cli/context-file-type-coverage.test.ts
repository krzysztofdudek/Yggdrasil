/**
 * `yg context --file` on a file enforced by its architecture type alone (no
 * owning component) — the typed view (build-context.ts / formatters/
 * context-file.ts) that REPLACES today's "not covered by any node" error for
 * such a file. Real spawned binary, real tests/fixtures/type-level-engine/
 * (Step 3).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');
const FIXTURE_BINARY_SUBJECT = path.join(FIXTURE, 'variants', 'binary-subject');
const FIXTURE_ZERO_ENFORCEMENT = path.join(FIXTURE, 'variants', 'zero-enforcement');
const FIXTURE_CYCLIC_TYPE = path.join(FIXTURE, 'variants', 'cyclic-type');
const distExists = existsSync(BIN_PATH);

function copyFixture(...overlays: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-context-file-typecov-'));
  cpSync(FIXTURE, dir, { recursive: true });
  for (const overlay of overlays) cpSync(overlay, dir, { recursive: true });
  return dir;
}

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

describe.skipIf(!distExists)('yg context --file — typed view for a type-covered file (Step 3)', () => {
  it('shows the matched type, chain termination, applied and dropped rules, the derived-relations note, and the graduation next-step', () => {
    const dir = copyFixture();
    try {
      const { stdout, status } = run(['context', '--file', 'src/leaf/a.ts'], dir);
      expect(status).toBe(0);
      // The matched type.
      expect(stdout).toContain('Matched type: leaf');
      // The inherited chain, where and why it stops (leaf -> mid -> top, absent parents).
      expect(stdout).toMatch(/inherited rules stop at 'top' — it has no parent type to inherit from/);
      // A rule that DOES apply.
      expect(stdout).toContain('own-file-rule');
      // A rule attached to the type that does NOT apply, with its reason.
      expect(stdout).toContain('drafty');
      expect(stdout).toMatch(/drafty.*draft/);
      expect(stdout).toContain('never-here');
      // The derived-relations honesty note.
      expect(stdout).toMatch(/worked out from this file's own imports/);
      // The graduation next-step.
      expect(stdout).toMatch(/give this file a component of its own/);
      // The OLD not-covered text must be gone for this file.
      expect(stdout).not.toContain('This file is not covered by any node.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A binary file whose only attached rule is an LLM (prose) aspect must show
  // the SAME reason context-file.ts's "Attached but not enforced" section
  // already gives every other drop — a silently missing drop here would
  // render the rule as [enforced] with no reason, which is false: a prose
  // rule can never review bytes it cannot read as text.
  it('a binary file whose only attached rule is an LLM aspect reports it as not enforced, with the binary-subject reason — never [enforced]', () => {
    const dir = copyFixture(FIXTURE_BINARY_SUBJECT);
    try {
      const { stdout, status } = run(['context', '--file', 'src/pics/logo.png'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Matched type: pics');
      // Never listed as a rule this file must satisfy.
      expect(stdout).not.toContain('Must satisfy:');
      expect(stdout).not.toMatch(/prose-rule \[enforced\]/);
      // Listed under "attached but not enforced", with the real reason.
      expect(stdout).toContain('Attached to this type but not enforced here:');
      expect(stdout).toMatch(/prose-rule — a binary file cannot be reviewed by a prose rule/);
      // The zero-rules statement fires for this file too — a binary subject
      // dropping its only attached rule still leaves it with no applicable
      // rule at all.
      expect(stdout).toContain('No rules from this type apply to this file — it satisfies coverage with no enforcement.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The SAME type's text file: prose-rule genuinely enforces there.
  it('the same type\'s text file shows prose-rule as a rule that DOES apply', () => {
    const dir = copyFixture(FIXTURE_BINARY_SUBJECT);
    try {
      const { stdout, status } = run(['context', '--file', 'src/pics/readme.md'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Must satisfy:');
      expect(stdout).toMatch(/prose-rule \[enforced\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An advisory rule must render its real status, not a hardcoded [enforced].
  // src/leaf/a.ts's own-file-rule implies
  // implied-file-rule (status: advisory, status_inherit: own-default) — a
  // rule that genuinely runs on this file but only warns.
  it('an advisory rule shows [advisory], never a hardcoded [enforced]', () => {
    const dir = copyFixture();
    try {
      const { stdout, status } = run(['context', '--file', 'src/leaf/a.ts'], dir);
      expect(status).toBe(0);
      expect(stdout).toMatch(/implied-file-rule \[advisory\]/);
      expect(stdout).not.toMatch(/implied-file-rule \[enforced\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A type-covered file with ZERO applicable rules must state the zero case
  // plainly, not say nothing at all — a silent gap here reads as "not worth
  // mentioning" rather than the honest "nothing enforces here" fact an agent
  // needs from the one surface it actually consults for this file.
  it('a type-covered file with zero applicable rules states the zero case plainly', () => {
    const dir = copyFixture(FIXTURE_ZERO_ENFORCEMENT);
    try {
      const { stdout, status } = run(['context', '--file', 'src/ep/e.ts'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('Matched type: emptyparents');
      expect(stdout).not.toContain('Must satisfy:');
      expect(stdout).toContain('No rules from this type apply to this file — it satisfies coverage with no enforcement.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // src/unclassified/x.ts matches no architecture type's when: at all — this
  // task must not change its behavior: the real, live "no graph coverage"
  // error (not context-file.ts's own long-dead "This file is not covered by
  // any node." branch, which no build-context.ts call site has ever reached)
  // still fires, unchanged.
  it('an ordinary unmapped, unclassified file keeps today\'s "no graph coverage" error unchanged', () => {
    const dir = copyFixture();
    try {
      const { stderr, status } = run(['context', '--file', 'src/unclassified/x.ts'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('has no graph coverage.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A type-covered file whose matched type's rules hit an implies cycle
  // (cyclic-a <-> cyclic-b, variants/cyclic-type) must never be told "No
  // rules from this type apply to this file — it satisfies coverage with no
  // enforcement": that reads as a clean, verified state, but the rules could
  // not be worked out at all. yg check independently reports the cycle as
  // aspect-implies-cycle and exits non-zero — this pins that the per-file
  // surface an agent actually consults for src/cyclic/z.ts tells the truth
  // too, naming the cycle instead of asserting nothing applies.
  it('a type-covered file whose type hit an implies cycle says so, naming it — never "nothing applies"', () => {
    const dir = copyFixture(FIXTURE_CYCLIC_TYPE);
    try {
      const { stdout, stderr, status } = run(['context', '--file', 'src/cyclic/z.ts'], dir);
      expect(status).toBe(1);
      expect(stdout).not.toContain('No rules from this type apply to this file');
      expect(stdout).not.toContain('it satisfies coverage with no enforcement');
      expect(stderr).toContain("matches type 'cyclic'");
      expect(stderr).toMatch(/implies cycle/);
      expect(stderr).toMatch(/cyclic-a|cyclic-b/);

      // yg check independently reports the SAME structural fault and stays red —
      // this fix must not touch that path.
      const checked = run(['check'], dir);
      expect(checked.status).toBe(1);
      expect(checked.stdout).toContain('aspect-implies-cycle');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
