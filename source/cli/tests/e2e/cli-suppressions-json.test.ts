// =============================================================================
// CLI E2E — `yg suppressions --json`.
//
// Horde's land-time guard needs to diff the waiver set of a base tree against a
// branch — refuse a branch that adds a `yg-suppress` the base tree never had —
// without scraping the prose inventory. These scenarios pin the document that
// replaces the scraping, PINNED AGAINST the unchanged text report (same run,
// same scan, only a different formatter over the same report), plus every edge
// the underlying scan already has to handle on real disk content.
//
//   1. two waivers + a wildcard    → one yg-suppressions/1 document, a wildcard warning
//   2. the same fixture, no flag   → byte-identical to the pre-change golden text
//   3. no markers anywhere         → empty lists, zero totals; text says "No active..."
//   4. unbounded disable mid-file  → kind disable, range.to null, unbounded-range warning
//   5. the SAME marker at the file head → kind file-level, no unbounded warning
//   6. marker naming an unknown aspect → code unknown-aspect, aspect names the marker's id
//   7. marker naming an errs: under aspect → code waives-under
//   8. a binary file and a zero-size file → skipped without exception
//   9. an unreadable file (chmod 000)  → still exit 0, that file skipped
//   10. a non-grammar extension (.sql) → raw-scan marker still in the document
//   11. TypeScript that fails to parse → marker still in the document (fallback)
//   12. unicode + space in a directory name → POSIX path, characters unchanged
//   13. a symlinked directory in the tree → exit 0, the scan does not loop
//   14. a thousand generated markers   → exit 0 under 20s, totals arithmetic holds
//   15. --json passed twice            → tolerated, exit 0
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'portal-suppress-forms');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** `portal-suppress-forms` — the same real fixture the integration test scans directly. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-suppjson-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

interface SuppressionsDoc {
  schema: string;
  markers: Array<{
    aspect: string;
    file: string;
    line: number;
    kind: 'single' | 'disable' | 'enable' | 'file-level';
    wildcard: boolean;
    reason: string | null;
    range: { from: number; to: number | null } | null;
  }>;
  warnings: Array<{ code: string; file: string; line: number; aspect: string | null; message: string }>;
  totals: { markers: number; files: number; fileLevel: number };
}

/** Adds one wildcard single-line marker to a fixture copy (scenarios 1 and 2 share this fixture). */
function addWildcardFile(dir: string): void {
  writeFileSync(
    path.join(dir, 'src', 'wild.ts'),
    ['export function wild(): number {', '  // yg-suppress(*) emergency bypass, tracked in TICKET-600', '  return 1;', '}', ''].join('\n'),
  );
}

// The pre-change text output for the base fixture PLUS `addWildcardFile` — captured
// from a real run before `ranges`/`warningRecords` were added to the report.
// `formatSuppressionsOutput` reads neither new field, so this must stay byte-identical.
const GOLDEN_TEXT_WITH_WILDCARD = `Active suppression markers:

  src/line.ts
    line 2: single(no-todo)  — tracked in TICKET-403, single-line waiver

  src/range.ts
    line 5: disable(no-todo)  — intentional legacy rounding, tracked in TICKET-402
    line 8: enable(no-todo)

  src/under.ts
    line 2: single(no-console)  — debug logging temporarily needed, tracked in TICKET-404

  src/whole.ts
    line 1: file-level(no-todo)  — legacy file, whole-file waiver — tracked in TICKET-401

  src/wild.ts
    line 2: single(*) [wildcard]  — emergency bypass, tracked in TICKET-600

Total: 6 markers across 5 files.

Warnings (2):
  yg-suppress(no-console) at src/under.ts:2 waives a check labeled errs: under.
  suppress targets an under-approximating check — such checks produce no false positives by design; either the errs label is wrong or this code path deserves a second look.
  Remove the waiver and re-examine the flagged code, or correct the aspect's errs label if 'under' is inaccurate.
  Wildcard suppression "*" at src/wild.ts:2 silences ALL aspects.
  A wildcard suppresses every current and future aspect check on the affected code — including ones not yet written. This masks problems broadly and is hard to audit.
  Replace "*" with the specific aspect id(s) you intend to suppress.
`;

describe.skipIf(!distExists)('CLI E2E — yg suppressions --json', () => {
  it('1: a fixture with several waivers plus a wildcard → one yg-suppressions/1 document, with a wildcard warning', () => {
    const dir = copyFixture('wildcard-json');
    try {
      addWildcardFile(dir);
      const result = run(['suppressions', '--json'], dir);
      expect(result.status).toBe(0);
      const doc = JSON.parse(result.stdout) as SuppressionsDoc;
      expect(doc.schema).toBe('yg-suppressions/1');
      const wildcardWarning = doc.warnings.find((w) => w.code === 'wildcard');
      expect(wildcardWarning).toBeDefined();
      expect(wildcardWarning!.file).toBe('src/wild.ts');
      expect(wildcardWarning!.aspect).toBeNull();
      expect(wildcardWarning!.message).toContain('silences ALL aspects');
      const wildcardMarker = doc.markers.find((m) => m.file === 'src/wild.ts');
      expect(wildcardMarker).toMatchObject({ aspect: '*', wildcard: true, kind: 'single' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: the same fixture WITHOUT --json → byte-identical to the pre-change golden (the text formatter never moved)', () => {
    const dir = copyFixture('wildcard-text');
    try {
      addWildcardFile(dir);
      const result = run(['suppressions'], dir);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(GOLDEN_TEXT_WITH_WILDCARD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3: a repository with no markers anywhere → --json gives empty lists and zero totals; without --json gives the "no markers" line', () => {
    const dir = copyFixture('no-markers');
    try {
      writeFileSync(path.join(dir, 'src', 'line.ts'), 'export function line(): number {\n  return 1;\n}\n');
      writeFileSync(
        path.join(dir, 'src', 'range.ts'),
        'export function beforeRange(): number {\n  return 0;\n}\n\nexport function range(): number {\n  return 1;\n}\n',
      );
      writeFileSync(path.join(dir, 'src', 'whole.ts'), 'export function whole(): number {\n  return 1;\n}\n');
      writeFileSync(path.join(dir, 'src', 'under.ts'), 'export function under(): number {\n  return 1;\n}\n');

      const json = run(['suppressions', '--json'], dir);
      expect(json.status).toBe(0);
      const doc = JSON.parse(json.stdout) as SuppressionsDoc;
      expect(doc).toEqual({
        schema: 'yg-suppressions/1',
        markers: [],
        warnings: [],
        totals: { markers: 0, files: 0, fileLevel: 0 },
      });

      const text = run(['suppressions'], dir);
      expect(text.status).toBe(0);
      expect(text.stdout).toBe('No active suppression markers found.\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4+5: an unbounded disable mid-file is "disable" with range.to null and an unbounded-range warning; the SAME marker at the file head is "file-level" with no such warning', () => {
    const dir = copyFixture('unbounded-vs-head');
    try {
      writeFileSync(
        path.join(dir, 'src', 'midfile.ts'),
        [
          'export function pad1(): number { return 1; }',
          'export function pad2(): number { return 2; }',
          'export function pad3(): number { return 3; }',
          'export function pad4(): number { return 4; }',
          'export function pad5(): number { return 5; }',
          'export function pad6(): number { return 6; }',
          '// yg-suppress-disable(no-todo) mid-file unbounded waiver, tracked in TICKET-500',
          'export function afterDisable(): number {',
          '  // TODO: still open, no matching enable anywhere below',
          '  return 7;',
          '}',
          '',
        ].join('\n'),
      );
      writeFileSync(
        path.join(dir, 'src', 'atheadfile.ts'),
        [
          '// yg-suppress-disable(no-todo) file-level waiver at the very top, tracked in TICKET-501',
          'export function wholeFile(): number {',
          '  // TODO: buried under the file-level waiver',
          '  return 1;',
          '}',
          '',
        ].join('\n'),
      );

      const doc = JSON.parse(run(['suppressions', '--json'], dir).stdout) as SuppressionsDoc;

      const midfile = doc.markers.find((m) => m.file === 'src/midfile.ts');
      expect(midfile).toMatchObject({ kind: 'disable', line: 7, range: { from: 7, to: null } });

      const athead = doc.markers.find((m) => m.file === 'src/atheadfile.ts');
      expect(athead).toMatchObject({ kind: 'file-level', line: 1, range: { from: 1, to: null } });

      const unboundedWarnings = doc.warnings.filter((w) => w.code === 'unbounded-range');
      expect(unboundedWarnings).toHaveLength(1);
      expect(unboundedWarnings[0].file).toBe('src/midfile.ts');
      expect(unboundedWarnings[0].message).toContain('has no matching yg-suppress-enable');
      expect(doc.warnings.some((w) => w.code === 'unbounded-range' && w.file === 'src/atheadfile.ts')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("6: a marker naming a nonexistent aspect → code unknown-aspect, aspect names the marker's own id", () => {
    const dir = copyFixture('unknown-aspect');
    try {
      writeFileSync(
        path.join(dir, 'src', 'unknown.ts'),
        [
          'export function unknownAspect(): number {',
          '  // yg-suppress(does-not-exist-aspect) naming a nonexistent aspect id',
          '  return 1;',
          '}',
          '',
        ].join('\n'),
      );
      const doc = JSON.parse(run(['suppressions', '--json'], dir).stdout) as SuppressionsDoc;
      const w = doc.warnings.find((x) => x.code === 'unknown-aspect');
      expect(w).toBeDefined();
      expect(w!.aspect).toBe('does-not-exist-aspect');
      expect(w!.file).toBe('src/unknown.ts');
      expect(w!.message).toContain('Unknown aspect id');
      expect(doc.markers.some((m) => m.file === 'src/unknown.ts' && m.aspect === 'does-not-exist-aspect')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("7: the base fixture's own under.ts (single-line marker on no-console, errs: under) → code waives-under", () => {
    const dir = copyFixture('waives-under');
    try {
      const doc = JSON.parse(run(['suppressions', '--json'], dir).stdout) as SuppressionsDoc;
      const w = doc.warnings.find((x) => x.code === 'waives-under');
      expect(w).toBeDefined();
      expect(w!.file).toBe('src/under.ts');
      expect(w!.aspect).toBe('no-console');
      expect(w!.message).toContain('errs: under');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('8: a binary file (NUL byte) and a zero-size file in the tree are skipped without an exception', () => {
    const dir = copyFixture('binary-and-empty');
    try {
      writeFileSync(path.join(dir, 'src', 'binary.ts'), Buffer.from([0, 1, 2, 66, 73, 78, 0]));
      writeFileSync(path.join(dir, 'src', 'empty.ts'), '');
      const result = run(['suppressions', '--json'], dir);
      expect(result.status).toBe(0);
      const doc = JSON.parse(result.stdout) as SuppressionsDoc;
      // Baseline fixture markers unaffected — the two new files contributed
      // nothing, and neither one crashed the scan.
      expect(doc.totals).toEqual({ markers: 5, files: 4, fileLevel: 1 });
      expect(doc.markers.some((m) => m.file === 'src/binary.ts' || m.file === 'src/empty.ts')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('9: an unreadable file (chmod 000) is skipped; the command still exits 0 with a valid document', () => {
    const dir = copyFixture('unreadable');
    const secretPath = path.join(dir, 'src', 'secret.ts');
    try {
      writeFileSync(
        secretPath,
        ['export function secret(): number {', '  // yg-suppress(no-todo) should never be read', '  return 1;', '}', ''].join('\n'),
      );
      chmodSync(secretPath, 0o000);
      const result = run(['suppressions', '--json'], dir);
      expect(result.status).toBe(0);
      const doc = JSON.parse(result.stdout) as SuppressionsDoc;
      expect(doc.schema).toBe('yg-suppressions/1');
      expect(doc.markers.some((m) => m.file === 'src/secret.ts')).toBe(false);
      // The rest of the fixture's markers are still there — one unreadable file
      // does not take down the whole scan.
      expect(doc.totals).toEqual({ markers: 5, files: 4, fileLevel: 1 });
    } finally {
      chmodSync(secretPath, 0o644);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('10: a non-grammar extension (.sql) with a marker in a real comment is still in the document (raw-scan path)', () => {
    const dir = copyFixture('sql-raw-scan');
    try {
      writeFileSync(
        path.join(dir, 'src', 'notes.sql'),
        '-- yg-suppress(sql-aspect) reporting batch, columns stable\nSELECT * FROM t;\n',
      );
      const doc = JSON.parse(run(['suppressions', '--json'], dir).stdout) as SuppressionsDoc;
      expect(doc.markers.some((m) => m.file === 'src/notes.sql' && m.aspect === 'sql-aspect')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('11: a TypeScript file that fails to parse still surfaces its marker (raw-scan fallback)', () => {
    const dir = copyFixture('broken-parse');
    try {
      writeFileSync(
        path.join(dir, 'src', 'broken.ts'),
        [
          'export function broken(: number {',
          '  // yg-suppress(broken-parse-aspect) still inventoried via the raw-scan fallback',
          '  return 1;',
          '}',
          '',
        ].join('\n'),
      );
      const doc = JSON.parse(run(['suppressions', '--json'], dir).stdout) as SuppressionsDoc;
      expect(doc.markers.some((m) => m.file === 'src/broken.ts' && m.aspect === 'broken-parse-aspect')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('12: a directory name with a space and unicode renders as a POSIX path, characters unchanged', () => {
    const dir = copyFixture('unicode-space-dir');
    try {
      const subdir = path.join(dir, 'src', 'legacy módule with space');
      mkdirSync(subdir, { recursive: true });
      writeFileSync(
        path.join(subdir, 'notes.ts'),
        ['export function spaced(): number {', '  // yg-suppress(no-todo) unicode + space directory path', '  return 1;', '}', ''].join('\n'),
      );
      const doc = JSON.parse(run(['suppressions', '--json'], dir).stdout) as SuppressionsDoc;
      const m = doc.markers.find((x) => x.file.includes('legacy módule with space'));
      expect(m).toBeDefined();
      expect(m!.file).toBe('src/legacy módule with space/notes.ts');
      expect(m!.file).not.toContain('\\');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('13: a symlinked directory in the tree does not make the scan loop; command exits 0 promptly', () => {
    const dir = copyFixture('symlink-loop');
    try {
      // Self-referential: src/loop -> src/ (its own parent). If the scanner ever
      // followed symlinked directories this would recurse forever; it does not
      // (lstat-based walk — see io/repo-scanner.ts), so this just proves the
      // EXISTING behavior stays inert rather than inventing new symlink support.
      symlinkSync('.', path.join(dir, 'src', 'loop'), 'dir');
      const result = run(['suppressions', '--json'], dir);
      expect(result.status).toBe(0);
      const doc = JSON.parse(result.stdout) as SuppressionsDoc;
      expect(doc.schema).toBe('yg-suppressions/1');
      expect(doc.totals).toEqual({ markers: 5, files: 4, fileLevel: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('14: a file with a thousand generated markers → exits 0, totals.markers accounts for all of them', () => {
    const dir = copyFixture('thousand-markers');
    try {
      const lines: string[] = [];
      for (let i = 1; i <= 1000; i++) {
        lines.push(`// yg-suppress(no-todo) generated waiver ${i}`);
        lines.push(`const genLine${i} = ${i};`);
      }
      writeFileSync(path.join(dir, 'src', 'generated-many.ts'), lines.join('\n') + '\n');

      const result = run(['suppressions', '--json'], dir);
      expect(result.status).toBe(0);
      const doc = JSON.parse(result.stdout) as SuppressionsDoc;
      // 1000 generated (one aspect per marker) plus the base fixture's own 5.
      expect(doc.totals.markers).toBe(1005);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('15: --json passed twice is tolerated (commander accepts a repeated boolean flag), exit 0', () => {
    const dir = copyFixture('json-twice');
    try {
      const result = run(['suppressions', '--json', '--json'], dir);
      expect(result.status).toBe(0);
      const doc = JSON.parse(result.stdout) as SuppressionsDoc;
      expect(doc.schema).toBe('yg-suppressions/1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
