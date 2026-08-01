import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Hermetic E2E for the type-level classification lattice (coverage.type_level)
// against the committed fixture tests/fixtures/type-coverage-basic/, spawning
// the real built binary. Companion to tests/unit/core/type-coverage.test.ts,
// which exercises computeTypeCoverage and the runCheck wiring directly — this
// suite confirms the same behavior is reachable through the actual CLI
// process: real exit code, real stdout.
//
// No git is needed: `yg check`'s primary coverage scan is a plain disk walk
// (io/repo-scanner.ts's walkRepoFiles), independent of git; only the
// tracked∩gitignored anomaly check consults real git, and it best-effort
// skips when none is found — neither of which this suite exercises.
//
// The committed fixture is never mutated — every run works on a mkdtemp copy,
// removed in a finally block.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-coverage-basic');
const PASS_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-coverage-basic-pass');
const RELATION_GATE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-relation-gate');
const PORTAL_TYPE_COVERAGE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'portal-type-coverage');
const distExists = existsSync(BIN_PATH);

function copyFixture(source: string = FIXTURE): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-type-coverage-e2e-'));
  cpSync(source, dir, { recursive: true });
  return dir;
}

function run(args: string[], cwd: string): { status: number | null; out: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

describe.skipIf(!distExists)('E2E: type-level classification lattice via the real CLI binary', () => {
  it('exits 1 (FAIL) and renders the ambiguous-node-type block naming both overlapping types', () => {
    const dir = copyFixture();
    try {
      const { status, out } = run(['check', '--details'], dir);
      expect(status).toBe(1);
      expect(out).toContain('FAIL');
      expect(out).toContain('ambiguous-node-type');
      expect(out).toContain('src/svc/overlap.ts');
      expect(out).toContain('svc');
      expect(out).toContain('util');
      expect(out).toContain('Two exits');
      // The strict-claimed file is reported by the strict scan, never as an
      // ambiguity, even though it also matches a non-strict type.
      expect(out).toContain('type-strict-orphan');
      // The excluded-root match (vendor/tool.ts) is muted entirely.
      expect(out).not.toContain('vendor/tool.ts');
      // The lattice is one issue per file, most-binding wins: the strict-claimed
      // file must not ALSO inflate the generic bulk "unmapped" listing.
      expect(out).not.toMatch(/unmapped[\s\S]{0,120}src\/util\/special\.ts/);
      // suggestedNext names the ambiguous file's own two-exit guidance, not the
      // generic structural fallback (`Next: Fix ambiguous-node-type in .yggdrasil`).
      expect(out).toContain('Next: Two exits:');
      expect(out).not.toContain('Next: Fix ambiguous-node-type in .yggdrasil');
      // Header split, corrected: this fixture has ZERO nodes, so "node-owned"
      // must read 0 — vendor/tool.ts (the excluded-root file) is its own
      // "excluded" term, never folded into "node-owned" just because the
      // legacy coveredFiles counter (unrelated to this label) counts it.
      // Sum invariant (core/check.ts is the source of truth; pinned again
      // here through the real CLI process): 0 node-owned + 1 type-covered
      // (handler.ts) + 1 excluded (vendor/tool.ts) + 1 ambiguous (overlap.ts)
      // + 1 strict-orphan (special.ts) + 1 unmapped (plain.ts) = 5 files.
      expect(out).toContain('2/5 files (0 node-owned, 1 type-covered, 1 excluded)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a PASS-twin fixture (no ambiguous file, flag on) prints the split PASS header', () => {
    const dir = copyFixture(PASS_FIXTURE);
    try {
      const { status, out } = run(['check', '--details'], dir);
      // Clean run: the only file this fixture's architecture cannot resolve is
      // the excluded-root vendor/tool.ts, muted entirely, and the digest-stale
      // warning (no agent-rules artifacts installed in the fixture) — neither
      // is a blocking error.
      expect(status).toBe(0);
      expect(out).toContain('yg check: PASS');
      // This fixture also has ZERO nodes: vendor/tool.ts (excluded root) is
      // its own "excluded" term, not "node-owned" — src/svc/handler.ts is
      // the one type-covered file. 0 + 1 + 1 = 2/2.
      expect(out).toContain('2/2 files (0 node-owned, 1 type-covered, 1 excluded)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a node whose directory mapping sweeps in an excluded subdirectory counts those files as excluded, never node-owned', () => {
    // The PASS-twin fixture has zero nodes; add one here whose mapping sweeps
    // a real (kept) file plus two more that a coverage.excluded root removes
    // from enforcement — the shape an adopter creates by excluding a vendored
    // copy that lives INSIDE an already-mapped directory. Before the header
    // counted these honestly, all three (not just the one real file) read as
    // "node-owned" because the mapping textually names them; the fix moves the
    // two excluded ones into the "excluded" term instead.
    const dir = copyFixture(PASS_FIXTURE);
    try {
      const archPath = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
      writeFileSync(
        archPath,
        readFileSync(archPath, 'utf-8') +
          '\n  plainnode:\n    description: "Matches src/svcnode/**, for the node-owned/excluded header split test."\n    when:\n      path: "src/svcnode/**"\n',
      );
      mkdirSync(path.join(dir, '.yggdrasil', 'model', 'svcnode'), { recursive: true });
      writeFileSync(
        path.join(dir, '.yggdrasil', 'model', 'svcnode', 'yg-node.yaml'),
        'name: Svcnode\ndescription: x\ntype: plainnode\nmapping:\n  - src/svcnode\n',
      );
      mkdirSync(path.join(dir, 'src', 'svcnode', 'vendor'), { recursive: true });
      writeFileSync(path.join(dir, 'src', 'svcnode', 'kept.ts'), 'export const kept = 1;\n');
      writeFileSync(path.join(dir, 'src', 'svcnode', 'vendor', 'a.ts'), 'export const a = 1;\n');
      writeFileSync(path.join(dir, 'src', 'svcnode', 'vendor', 'b.ts'), 'export const b = 1;\n');
      const configPath = path.join(dir, '.yggdrasil', 'yg-config.yaml');
      writeFileSync(
        configPath,
        readFileSync(configPath, 'utf-8').replace('excluded:\n    - vendor/', 'excluded:\n    - vendor/\n    - src/svcnode/vendor/'),
      );

      const { out } = run(['check', '--details'], dir);
      // 5 files total: handler.ts (type-covered), vendor/tool.ts (excluded),
      // svcnode/kept.ts (the one genuinely node-owned file), and the two
      // svcnode/vendor/*.ts files — mapped by svcnode's directory entry, but
      // excluded, so they must land in "excluded", not "node-owned".
      expect(out).toContain('5/5 files (1 node-owned, 1 type-covered, 3 excluded)');
      // Agreement across surfaces, on the SAME run: yg context --node names
      // only the one real subject file this node actually enforces.
      const context = run(['context', '--node', 'svcnode'], dir);
      expect(context.out).toContain('Source files (1)');
      expect(context.out).toContain('src/svcnode/kept.ts');
      expect(context.out).not.toContain('vendor/a.ts');
      expect(context.out).not.toContain('vendor/b.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!distExists)('E2E: yg tree — the type-covered summary line', () => {
  it('flag off: no summary line at all, byte-identical to the node listing alone', () => {
    const onDir = copyFixture(RELATION_GATE_FIXTURE);
    const offDir = copyFixture(RELATION_GATE_FIXTURE);
    try {
      const configPath = path.join(offDir, '.yggdrasil', 'yg-config.yaml');
      writeFileSync(configPath, readFileSync(configPath, 'utf-8').replace('type_level: true', 'type_level: false'));

      const flagOff = run(['tree'], offDir);
      expect(flagOff.status).toBe(0);
      expect(flagOff.out).toContain('owner [owner-type]');
      expect(flagOff.out).not.toMatch(/satisfied by the type-level lattice/);

      // Flipping the flag back on is the ONLY difference this pin permits —
      // proving flag-off is not merely "the fixture has no type-covered files"
      // but genuinely "the flag suppresses the line".
      const flagOn = run(['tree'], onDir);
      expect(flagOn.out).not.toBe(flagOff.out);
      expect(flagOn.out.startsWith(flagOff.out)).toBe(true);
    } finally {
      rmSync(onDir, { recursive: true, force: true });
      rmSync(offDir, { recursive: true, force: true });
    }
  });

  it('flag on: a summary line follows the node listing, naming the type-covered file count', () => {
    const dir = copyFixture(RELATION_GATE_FIXTURE);
    try {
      const { status, out } = run(['tree'], dir);
      expect(status).toBe(0);
      expect(out).toContain('owner [owner-type]');
      // svc/handler.ts (type svc) and util/plain-util.ts (type util) are the
      // fixture's two cleanly type-covered files; ambiguous.ts is excluded from
      // the covered bucket by the lattice itself.
      expect(out).toMatch(/2 files? .*satisfied by (the )?type-level/i);
      // The tree's own node listing renders NODES only — no synthetic entry for
      // a type-covered file appears in the flat list above the summary line.
      expect(out).not.toContain('handler.ts');
      expect(out).not.toContain('plain-util.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--root scopes the node listing but the lattice has no subtree of its own — the summary states it is repo-wide, never a fabricated scoped count', () => {
    const dir = copyFixture(RELATION_GATE_FIXTURE);
    try {
      const { status, out } = run(['tree', '--root', 'owner'], dir);
      expect(status).toBe(0);
      expect(out).toContain('owner [owner-type]');
      expect(out).toMatch(/2 files? .*satisfied by (the )?type-level/i);
      expect(out).toMatch(/repo-wide/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the summary line splits enforced from unenforced — never one conflated "satisfied" figure, matching the portal\'s own split', () => {
    // portal-type-coverage: one node-owned file (gateway), src/svc/handler.ts type-covered
    // as 'svc' with a real deterministic aspect attached (enforced — a real pair exists
    // regardless of whether it has been filled yet), src/lib/util.ts type-covered as 'lib'
    // with no aspects at all (unenforced — matched a type, checked by nothing). `yg tree`'s
    // single "2 files are satisfied" figure used to fold both into one number indistinguishable
    // from "both checked"; the portal already splits this into two named residue lines — the
    // command must agree, not just count.
    const dir = copyFixture(PORTAL_TYPE_COVERAGE_FIXTURE);
    try {
      const { status, out } = run(['tree'], dir);
      expect(status).toBe(0);
      expect(out).toMatch(/2 files? .*satisfied by (the )?type-level/i);
      expect(out).toMatch(/1 checked by at least one rule/);
      expect(out).toMatch(/1 with nothing that applies/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--root naming an unknown node prints the "Error: " prefixed not-found message, in BOTH flag states', () => {
    // The type-covered summary line never has a chance to run here — the --root lookup
    // fails before the node listing (and the line after it) is ever built — so this error
    // path must render identically whether or not coverage.type_level is on. The "Error: "
    // prefix is the canonical bespoke-error form cli-command-contract requires for a
    // constant-text command error like this one (its own content.md names "node not found"
    // as an example) — dropping it would be a regression, not a fix, independent of this flag.
    const onDir = copyFixture(RELATION_GATE_FIXTURE);
    const offDir = copyFixture(RELATION_GATE_FIXTURE);
    try {
      const configPath = path.join(offDir, '.yggdrasil', 'yg-config.yaml');
      writeFileSync(configPath, readFileSync(configPath, 'utf-8').replace('type_level: true', 'type_level: false'));

      const flagOn = run(['tree', '--root', 'nosuch'], onDir);
      const flagOff = run(['tree', '--root', 'nosuch'], offDir);
      for (const result of [flagOn, flagOff]) {
        expect(result.status).toBe(1);
        expect(result.out).toContain("Error: Node 'nosuch' not found.");
      }
      expect(flagOn.out).toBe(flagOff.out);
    } finally {
      rmSync(onDir, { recursive: true, force: true });
      rmSync(offDir, { recursive: true, force: true });
    }
  });
});
