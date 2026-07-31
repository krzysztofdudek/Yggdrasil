// =============================================================================
// E2E — `yg aspect-test --file <path>`: run an aspect against ONE file
// enforced by its architecture type alone (no owning component), as opposed
// to `--node` (a real component) and `--files` (ad-hoc, no graph attachment).
//
// Real spawned binary against the committed tests/fixtures/type-level-engine
// merged with its two-covered-files variant (src/leaf/{a,b}.ts are
// type-covered by 'leaf', alongside the real 'owned' node of the same type).
//
// HERMETIC: fresh mkdtemp merge per test, mutated in place where a test needs
// its own ad-hoc aspect, rmSync'd in finally.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const BASE_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');
const distExists = existsSync(BIN_PATH);
const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function copyMergedFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-aspecttest-file-'));
  cpSync(BASE_FIXTURE, dir, { recursive: true });
  cpSync(path.join(BASE_FIXTURE, 'variants', 'two-covered-files'), dir, { recursive: true });
  return dir;
}

function addReviewer(dir: string, endpoint: string): void {
  appendFileSync(
    cfgPath(dir),
    `\nreviewer:\n  default: standard\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: "mock-model"\n        endpoint: "${endpoint}"\n`,
  );
}

/** Write a standalone deterministic aspect into the fixture copy — not part
 *  of the shared fixture, so it never needs architecture attachment (aspect-test
 *  --node/--file both run ad-hoc, test-before-attach). */
function writeAdhocDetAspect(dir: string, id: string, checkBody: string): void {
  const adir = path.join(dir, '.yggdrasil', 'aspects', id);
  mkdirSync(adir, { recursive: true });
  writeFileSync(path.join(adir, 'yg-aspect.yaml'), `name: ${id}\ndescription: ad-hoc test aspect\nreviewer:\n  type: deterministic\nscope:\n  per: file\n`);
  writeFileSync(path.join(adir, 'check.mjs'), checkBody);
}

describe.skipIf(!distExists)('CLI E2E — yg aspect-test --file', () => {
  it('refuses --file combined with --node as ambiguous', () => {
    const dir = copyMergedFixture();
    try {
      const { status, stderr } = run(['aspect-test', '--aspect', 'own-file-rule', '--file', 'src/leaf/a.ts', '--node', 'owned'], dir);
      expect(status).toBe(1);
      expect(stderr.toLowerCase()).toMatch(/ambiguous|mutually exclusive|both/);
      expect(stderr).toMatch(/--file/);
      expect(stderr).toMatch(/--node/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses --file on a path that has a component, pointing at --node', () => {
    const dir = copyMergedFixture();
    try {
      // src/owned/o.ts IS mapped by the real 'owned' node — it has a component.
      const { status, stderr } = run(['aspect-test', '--aspect', 'own-file-rule', '--file', 'src/owned/o.ts'], dir);
      expect(status).toBe(1);
      expect(stderr).toContain('owned');
      expect(stderr).toMatch(/--node/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses --file on an untyped path, naming the classification problem', () => {
    const dir = copyMergedFixture();
    try {
      // src/unclassified/x.ts matches no architecture type in this fixture.
      const { status, stderr } = run(['aspect-test', '--aspect', 'own-file-rule', '--file', 'src/unclassified/x.ts'], dir);
      expect(status).toBe(1);
      expect(stderr.toLowerCase()).toMatch(/no architecture type|not addressable|unmatched/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses --file on an ambiguous path, naming the classification problem', () => {
    const dir = copyMergedFixture();
    try {
      // Add a second type matching the SAME path glob as 'leaf' — src/leaf/a.ts
      // now matches two non-strict types.
      const arch = path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
      const content = readFileSync(arch, 'utf-8');
      writeFileSync(
        arch,
        content.replace(
          'node_types:\n',
          'node_types:\n  leaf2:\n    description: "A second type matching the same files as leaf, to force ambiguity."\n    when:\n      path: "src/leaf/**"\n',
        ),
      );
      const { status, stderr } = run(['aspect-test', '--aspect', 'own-file-rule', '--file', 'src/leaf/a.ts'], dir);
      expect(status).toBe(1);
      expect(stderr.toLowerCase()).toContain('ambiguous');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--file with a deterministic aspect runs the check with the architecture reach, over the real file content', () => {
    const dir = copyMergedFixture();
    try {
      writeAdhocDetAspect(
        dir,
        'ad-hoc-content-check',
        `export function check(ctx) {\n  const content = ctx.subject[0].content;\n  if (content.includes('BAD')) {\n    return [{ file: ctx.subject[0].path, line: 1, message: 'contains BAD' }];\n  }\n  return [];\n}\n`,
      );
      const clean = run(['aspect-test', '--aspect', 'ad-hoc-content-check', '--file', 'src/leaf/a.ts'], dir);
      expect(clean.stdout).toContain('satisfied');
      expect(clean.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--file with a deterministic aspect that reaches outside the architecture-permitted set is refused (never a crash)', () => {
    const dir = copyMergedFixture();
    try {
      writeAdhocDetAspect(
        dir,
        'ad-hoc-overreach',
        `export function check(ctx) {\n  ctx.fs.read('src/definitely/not/anywhere.ts');\n  return [];\n}\n`,
      );
      const { status, stderr } = run(['aspect-test', '--aspect', 'ad-hoc-overreach', '--file', 'src/leaf/a.ts'], dir);
      expect(status).toBe(1);
      expect(stderr).toMatch(/undeclared|not.*permit|architecture/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--file with a deterministic aspect that touches ctx.node is refused, naming both exits', () => {
    const dir = copyMergedFixture();
    try {
      writeAdhocDetAspect(
        dir,
        'ad-hoc-touches-node',
        `export function check(ctx) {\n  const t = ctx.node.type;\n  return [];\n}\n`,
      );
      const { status, stderr } = run(['aspect-test', '--aspect', 'ad-hoc-touches-node', '--file', 'src/leaf/a.ts'], dir);
      expect(status).toBe(1);
      expect(stderr.toLowerCase()).toMatch(/no owning component|unavailable/);
      expect(stderr).toMatch(/give.*component of its own|rewrite/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--file with an LLM aspect and --dry-run prints the nodeless prompt variant, no <node> element', () => {
    const dir = copyMergedFixture();
    try {
      // Tier resolution runs even for --dry-run (it never CALLS the reviewer,
      // but still needs a resolvable tier) — a bogus, never-dialed endpoint is
      // fine since no request is ever made.
      addReviewer(dir, 'http://127.0.0.1:1');
      const { status, stdout } = run(['aspect-test', '--aspect', 'llm-leaf-rule', '--file', 'src/leaf/b.ts', '--dry-run'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('src/leaf/b.ts');
      expect(stdout).not.toContain('<node');
      expect(stdout).not.toContain('node (component)');
      expect(stdout).toContain('Below is a single source file with its content and one aspect (rule set).');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--file with an LLM aspect (live) runs the reviewer over the type-covered file', async () => {
    const dir = copyMergedFixture();
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true, reason: 'mock-approve' }) });
    try {
      addReviewer(dir, mock.endpoint);
      const out = await runAsync(['aspect-test', '--aspect', 'llm-leaf-rule', '--file', 'src/leaf/b.ts'], dir);
      expect(out.status).toBe(0);
      expect(out.all).toContain('satisfied');
      expect(mock.chatCount()).toBeGreaterThan(0);
      expect(mock.chatRequests[0].prompt).not.toContain('<node');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--files (ad-hoc) keeps its current behavior untouched alongside the new --file flag', () => {
    const dir = copyMergedFixture();
    try {
      const { status, stdout } = run(['aspect-test', '--aspect', 'own-file-rule', '--files', 'src/leaf/a.ts'], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('satisfied');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// yg-suppress on a file enforced by its architecture type alone (no owning
// component) — a suppression waives a rule for specific lines regardless of
// whether the subject is a real component or a type-covered file; both the
// spans the reviewer prompt receives and the read-only inventory (`yg
// suppressions`) key off the SUBJECT FILE, never a node, so neither needed a
// code change to see a nodeless subject. These two tests are the pin the
// earlier work described but never wrote: suppression is a trust surface,
// and a waiver nobody can audit is worse than no waiver.
// =============================================================================

/**
 * Append a single-line `yg-suppress(<aspectId>)` marker to the end of
 * `absFile` and return the 1-based line it waives (the resolver covers
 * exactly the line immediately below the marker, never the marker's own
 * line). Computed by scanning the WRITTEN file rather than by arithmetic, so
 * the assertion cannot drift if the fixture's own content ever changes.
 */
function appendSuppressMarker(absFile: string, aspectId: string, reason: string): number {
  const body = readFileSync(absFile, 'utf-8');
  writeFileSync(
    absFile,
    `${body}\n// yg-suppress(${aspectId}) ${reason}\nexport const SUPPRESSED_LINE = 1;\n`,
    'utf-8',
  );
  const lines = readFileSync(absFile, 'utf-8').split('\n');
  const markerIdx = lines.findIndex((l) => l.includes(`yg-suppress(${aspectId})`));
  return markerIdx + 2; // 1-based line below the marker
}

describe.skipIf(!distExists)('CLI E2E — yg-suppress on a file enforced by its architecture type alone', () => {
  it('a marker in a type-covered file (no owning component) reaches the assembled --file prompt as a suppressed range, with the honor instruction', () => {
    const dir = copyMergedFixture();
    try {
      // Tier resolution runs even for --dry-run — a bogus, never-dialed
      // endpoint is fine since no reviewer request is ever made (mirrors the
      // plain --dry-run test above).
      addReviewer(dir, 'http://127.0.0.1:1');
      // src/leaf/b.ts is type-covered by 'leaf', no node of its own.
      // llm-leaf-rule is the LLM aspect attached to 'leaf' (per: file).
      const suppressedLine = appendSuppressMarker(
        path.join(dir, 'src', 'leaf', 'b.ts'),
        'llm-leaf-rule',
        'known debt, tracked in the issue tracker',
      );

      const { status, stdout } = run(['aspect-test', '--aspect', 'llm-leaf-rule', '--file', 'src/leaf/b.ts', '--dry-run'], dir);
      expect(status).toBe(0);
      // The resolved span reached the assembled prompt exactly like it would
      // for a component-owned file — same block, same file key, same line.
      expect(stdout).toContain('</suppressed-ranges>');
      expect(stdout).toContain('<file path="src/leaf/b.ts">');
      expect(stdout).toContain(`<range start-line="${suppressedLine}" end-line="${suppressedLine}" />`);
      // The reviewer is instructed to honor exactly those lines (unified text
      // — same instruction a component-owned prompt carries).
      expect(stdout).toContain('Honor exactly these line ranges');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('yg suppressions lists a marker in a type-covered file (no owning component), naming the subject file and the rule', () => {
    const dir = copyMergedFixture();
    try {
      appendSuppressMarker(
        path.join(dir, 'src', 'leaf', 'b.ts'),
        'llm-leaf-rule',
        'known debt, tracked in the issue tracker',
      );

      const { status, stdout } = run(['suppressions'], dir);
      expect(status).toBe(0);
      // The scan groups by SUBJECT FILE — never a node — so a file with no
      // owning component is inventoried exactly like one that has one.
      expect(stdout).toContain('src/leaf/b.ts');
      expect(stdout).toContain('single(llm-leaf-rule)');
      expect(stdout).toContain('known debt, tracked in the issue tracker');
      expect(stdout).toContain('Total: 1 marker across 1 file.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
