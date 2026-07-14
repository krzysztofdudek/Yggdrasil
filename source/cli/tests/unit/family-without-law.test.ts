// =============================================================================
// family-without-law miner — precision + determinism gate (RZ-21 admission control).
//
// Drives the OFFLINE miner through its PUBLIC surface (spawn `node
// scripts/family-without-law.mjs`), which in turn drives the real CLI over real
// on-disk fixture projects (real AST shards, produced by the normal parse path —
// nothing fabricated). The precision gate here is what admits the family surface
// into `yg advise` (Task 2): the miner must find EXACTLY the planted families,
// invent ZERO false ones, tag them by language, never merge across languages, and
// be byte-identical across two runs. On this repo it must invent no false family.
//
// Spawn-based, so it needs the built CLI (`dist/bin.js`); it self-skips when the
// build is absent (repo-check builds before the test run — same guard as the E2E
// suites).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..'); // source/cli
const REPO_ROOT = path.join(CLI_ROOT, '..', '..');
const MINER = path.join(REPO_ROOT, 'scripts', 'family-without-law.mjs');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURES = path.join(CLI_ROOT, 'tests', 'fixtures');
const distExists = existsSync(BIN_PATH);

const FIXED_TS = '2020-02-02T02:02:02.000Z';
const OTHER_TS = '2099-11-30T23:59:58.000Z';
const CAVEAT =
  'Note: "no shared aspect" is near-vacuous — type-default and broad-parent cascades are ' +
  'excluded, so a family fires only when the cluster shares no NARROW (own / port / ' +
  'narrow-ancestor) aspect that would already be its law.';

interface Family {
  id: string;
  language: string;
  members: string[];
  fittedPredicate: { kind: string; value: string };
  scopeFilesDraft: string[];
  evidence: { clusterSize: number; tightness: number; sharedDiscriminatingAspects: string[] };
}
interface Candidates {
  v: number;
  ts: string;
  coverage: string[];
  families: Family[];
}

function runMiner(root: string, ts: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('node', [MINER, '--root', root, '--ts', ts], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function readCandidates(root: string): Candidates {
  const p = path.join(root, '.yggdrasil', '.family-candidates.json');
  return JSON.parse(readFileSync(p, 'utf-8')) as Candidates;
}

/** Copy the committed fixture to a scratch dir and strip any rebuildable caches, so the miner
 *  regenerates real shards through the normal parse path (never a stale/fabricated cache). Also
 *  removes the `.family-candidates.json` gitignore line so the writer's SELF-ENSURE is tested. */
function stageFixture(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-family-${name}-`));
  cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  for (const cache of ['.ast-cache', '.symbols-cache', '.feature-field.json', '.family-candidates.json']) {
    rmSync(path.join(dir, '.yggdrasil', cache), { recursive: true, force: true });
  }
  const giPath = path.join(dir, '.yggdrasil', '.gitignore');
  if (existsSync(giPath)) {
    const kept = readFileSync(giPath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim() !== '.family-candidates.json')
      .join('\n');
    writeFileSync(giPath, kept, 'utf-8');
  }
  return dir;
}

/** Structural invariants every SHIPPED family must satisfy — the "no false family" guarantee
 *  expressed mechanically: a family is only ever emitted tight, law-less, and WITH fitted
 *  reach evidence, so `sharedDiscriminatingAspects` is empty by construction. */
function expectWellFormed(f: Family): void {
  expect(f.id).toMatch(/^family-[a-z]+-[0-9a-f]{12}$/);
  expect(typeof f.language).toBe('string');
  expect(f.id).toContain(`family-${f.language}-`);
  expect(Array.isArray(f.members)).toBe(true);
  expect(f.members.length).toBeGreaterThanOrEqual(1);
  expect([...f.members].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(f.members); // sorted
  expect(new Set(f.members).size).toBe(f.members.length); // no dupes
  expect(['glob', 'regex']).toContain(f.fittedPredicate.kind);
  expect(typeof f.fittedPredicate.value).toBe('string');
  expect(f.fittedPredicate.value.length).toBeGreaterThan(0);
  expect(f.scopeFilesDraft.length).toBeGreaterThanOrEqual(1);
  expect(f.evidence.clusterSize).toBe(f.members.length);
  expect(typeof f.evidence.tightness).toBe('number');
  expect(f.evidence.sharedDiscriminatingAspects).toEqual([]);
}

describe.skipIf(!distExists)('family-without-law miner — spawn smoke', () => {
  it('runs offline, exits 0, and prints the near-vacuous caveat verbatim', () => {
    const dir = stageFixture('family-planted-mono');
    try {
      const res = runMiner(dir, FIXED_TS);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(CAVEAT);
      expect(res.stdout).toContain('Candidate families');
      expect(res.stdout).toContain('never writes an aspect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!distExists)('family-without-law miner — mono precision (exact recall, zero false)', () => {
  it('finds EXACTLY the one planted family with a fitted glob, and nothing else', () => {
    const dir = stageFixture('family-planted-mono');
    try {
      const res = runMiner(dir, FIXED_TS);
      expect(res.status).toBe(0);
      const data = readCandidates(dir);

      expect(data.v).toBe(1);
      expect(data.ts).toBe(FIXED_TS);
      expect(data.coverage).toEqual(['typescript']);
      expect(data.families).toHaveLength(1); // exactly one — zero false families

      const fam = data.families[0];
      expectWellFormed(fam);
      expect(fam.language).toBe('typescript');
      expect(fam.members).toEqual([
        'src/data/InvoiceRepository.ts',
        'src/data/OrderRepository.ts',
        'src/data/PaymentRepository.ts',
        'src/data/ProductRepository.ts',
        'src/data/UserRepository.ts',
      ]);
      expect(fam.fittedPredicate).toEqual({ kind: 'glob', value: 'src/data/*Repository.ts' });
      expect(fam.scopeFilesDraft).toEqual(['src/data/*Repository.ts']);
      expect(fam.evidence.clusterSize).toBe(5);

      // No decoy ever appears in a family. There are FIVE mutually-distinct decoys (>= the
      // minimum cluster size), so this also proves the miner rejects a dissimilar 5+ set
      // rather than relying on there being too few decoys to form one.
      const allMembers = data.families.flatMap((f) => f.members);
      for (const decoy of [
        'src/support/router.ts',
        'src/support/mathx.ts',
        'src/support/settings.ts',
        'src/support/client.ts',
        'src/support/dispatcher.ts',
      ]) {
        expect(allMembers).not.toContain(decoy);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the output under the fixture .yggdrasil and self-ensures its gitignore line (G5)', () => {
    const dir = stageFixture('family-planted-mono');
    try {
      // Pre-condition: stageFixture stripped the line, so the writer must add it.
      const giBefore = readFileSync(path.join(dir, '.yggdrasil', '.gitignore'), 'utf-8');
      expect(giBefore).not.toContain('.family-candidates.json');

      runMiner(dir, FIXED_TS);

      expect(existsSync(path.join(dir, '.yggdrasil', '.family-candidates.json'))).toBe(true);
      const giAfter = readFileSync(path.join(dir, '.yggdrasil', '.gitignore'), 'utf-8');
      expect(giAfter).toContain('.family-candidates.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is deterministic — two runs with different clocks yield byte-identical families', () => {
    const dir = stageFixture('family-planted-mono');
    try {
      runMiner(dir, FIXED_TS);
      const first = JSON.stringify(readCandidates(dir).families);
      runMiner(dir, OTHER_TS);
      const second = readCandidates(dir);
      expect(JSON.stringify(second.families)).toBe(first); // families identical
      expect(second.ts).toBe(OTHER_TS); // …but the clock is injected, not baked into families
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!distExists)('family-without-law miner — polyglot precision (two strata, never merged)', () => {
  it('finds both planted families, language-tagged, and never merges across languages', () => {
    const dir = stageFixture('family-planted-polyglot');
    try {
      const res = runMiner(dir, FIXED_TS);
      expect(res.status).toBe(0);
      const data = readCandidates(dir);

      expect(data.coverage).toEqual(['python', 'typescript']);
      expect(data.families).toHaveLength(2);
      data.families.forEach(expectWellFormed);

      const byLang = new Map(data.families.map((f) => [f.language, f]));
      expect([...byLang.keys()].sort()).toEqual(['python', 'typescript']);

      const ts = byLang.get('typescript')!;
      expect(ts.members).toEqual([
        'src/ts/InvoiceRepository.ts',
        'src/ts/OrderRepository.ts',
        'src/ts/PaymentRepository.ts',
        'src/ts/ProductRepository.ts',
        'src/ts/UserRepository.ts',
      ]);
      expect(ts.fittedPredicate).toEqual({ kind: 'glob', value: 'src/ts/*Repository.ts' });

      const py = byLang.get('python')!;
      expect(py.members).toEqual([
        'src/py/invoice_repository.py',
        'src/py/order_repository.py',
        'src/py/payment_repository.py',
        'src/py/product_repository.py',
        'src/py/user_repository.py',
      ]);
      expect(py.fittedPredicate).toEqual({ kind: 'glob', value: 'src/py/*_repository.py' });

      // Never merged across languages: no family mixes .ts and .py members. NOTE: this is a
      // design-guaranteed regression guard, not the active precision content — clustering runs
      // strictly within one extractor language, so a cross-language merge is impossible today;
      // this asserts that invariant can never silently regress. The active precision content is
      // the decoy-EXCLUSION assertion below (a real, structurally-similar pair that must not
      // surface).
      for (const f of data.families) {
        const hasTs = f.members.some((m) => m.endsWith('.ts'));
        const hasPy = f.members.some((m) => m.endsWith('.py'));
        expect(hasTs && hasPy).toBe(false);
      }

      // The superficially-similar cross-language decoy pair never clusters.
      const allMembers = data.families.flatMap((f) => f.members);
      expect(allMembers).not.toContain('src/ts/ConfigLoader.ts');
      expect(allMembers).not.toContain('src/py/config_loader.py');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!distExists)('family-without-law miner — faithful reach (drops over-reaching predicates)', () => {
  it('finds the cleanly-fittable family but DROPS the family whose only predicate over-reaches a non-member', () => {
    const dir = stageFixture('family-affix-overmatch');
    try {
      const res = runMiner(dir, FIXED_TS);
      expect(res.status).toBe(0);
      const data = readCandidates(dir);

      // The clean family IS found — proves clustering + fitting still work, so the drop below
      // is a genuine faithful-reach drop, not a failure to cluster.
      expect(data.families).toHaveLength(1);
      const fam = data.families[0];
      expectWellFormed(fam);
      expect(fam.fittedPredicate).toEqual({ kind: 'glob', value: 'src/clean/*Service.ts' });
      expect(fam.members).toEqual([
        'src/clean/InvoiceService.ts',
        'src/clean/OrderService.ts',
        'src/clean/PaymentService.ts',
        'src/clean/ProductService.ts',
        'src/clean/UserService.ts',
      ]);

      // The `src/repo/*Repository.ts` cluster IS tight and law-less, but its only fitting
      // glob/regex also reaches the structurally-distinct non-member `LegacyRepository.ts`, so
      // it must be DROPPED. Removing the faithful-reach check would re-surface it here — a real
      // regression assertion, not a comment.
      const allMembers = data.families.flatMap((f) => f.members);
      for (const repoFile of [
        'src/repo/UserRepository.ts',
        'src/repo/OrderRepository.ts',
        'src/repo/ProductRepository.ts',
        'src/repo/InvoiceRepository.ts',
        'src/repo/PaymentRepository.ts',
        'src/repo/LegacyRepository.ts',
      ]) {
        expect(allMembers).not.toContain(repoFile);
      }
      // No emitted predicate is the over-reaching `src/repo/*Repository.ts` (which would match
      // the non-member `src/repo/LegacyRepository.ts`).
      for (const f of data.families) {
        expect(f.fittedPredicate.value).not.toBe('src/repo/*Repository.ts');
        expect(f.scopeFilesDraft).not.toContain('src/repo/*Repository.ts');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!distExists)('family-without-law miner — this repo (no false families)', () => {
  it('mines this repository and every reported family is well-formed (zero false by construction)', () => {
    const res = runMiner(REPO_ROOT, FIXED_TS);
    expect(res.status).toBe(0);
    const data = readCandidates(REPO_ROOT);

    expect(data.v).toBe(1);
    expect(Array.isArray(data.coverage)).toBe(true);
    expect(Array.isArray(data.families)).toBe(true);
    // Test scaffolding and fixtures are excluded, so the planted fixtures never leak in here.
    for (const f of data.families) {
      expectWellFormed(f);
      for (const m of f.members) expect(m).not.toMatch(/(^|\/)(tests|fixtures|node_modules|dist)\//);
    }
  }, 30_000);
});
