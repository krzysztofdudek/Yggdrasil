// =============================================================================
// Unit tests for `yg simulate` — the deterministic-replay command.
//
// The centrepiece is the CLONE-BOUNDARY GUARD (resolveYggRootWithinClone): the
// single most security-critical helper in simulate. findYggRoot walks UP the
// directory tree, so a checked-out commit that PRE-DATES `yg init` has no
// `.yggdrasil/` in the clone and a naive resolve would climb OUT of the clone and
// silently find the REAL repo's graph. The guard must refuse to escape. The proof
// below constructs exactly that hazard — an ancestor graph (standing in for the
// real repo) with a graph-less clone dir beneath it — and shows (a) the raw
// resolver really does escape, and (b) the guard returns non-comparable without
// consulting the ancestor.
//
// The remaining tests pin the pure helpers (candidate-kind detection, schema
// read, run classification, arg parsing, report rendering incl. the verbatim Wald
// label). The full black-box behaviour (spawned bin.js, real git history,
// per-commit outcomes, real-tree byte-compare) lives in the e2e suite.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findYggRoot } from '../../../src/io/paths.js';
import {
  resolveYggRootWithinClone,
  detectCandidateKind,
  readConfigVersion,
  classifyAspectTestRun,
  parseMaxCommits,
  renderReport,
  runSimulation,
  isPlainRelativeName,
  pathIsWithin,
  realpathIsWithin,
  overlayCurrentArchitectureAndCoverage,
  WALD_LABEL,
  type CommitOutcome,
  type SimulateTarget,
} from '../../../src/cli/simulate.js';

function mkTmp(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `yg-sim-${label}-`));
}

describe('yg simulate — clone-boundary guard (the security crux)', () => {
  it('refuses to escape the clone: a graph-less checkout is non-comparable, the ancestor (real) graph is NOT consulted', async () => {
    // The hazard, made concrete: an ancestor directory that HAS a `.yggdrasil/`
    // (this stands in for the real repository the clone was made from), with a
    // clone directory directly beneath it that has NO `.yggdrasil/` of its own —
    // exactly a checkout that predates `yg init`.
    const ancestor = mkTmp('ancestor');
    mkdirSync(path.join(ancestor, '.yggdrasil'), { recursive: true });
    const clone = path.join(ancestor, 'clone');
    mkdirSync(clone, { recursive: true });
    try {
      // (a) The hazard is REAL: the raw resolver walks up and finds the ancestor
      //     graph — this is precisely what the guard must prevent.
      const escaped = await findYggRoot(clone);
      expect(escaped).toBe(path.join(path.resolve(ancestor), '.yggdrasil'));

      // (b) The GUARD refuses to escape: it returns null (non-comparable) and never
      //     returns the ancestor graph — the real repo is never consulted.
      const guarded = await resolveYggRootWithinClone(clone);
      expect(guarded).toBeNull();
    } finally {
      rmSync(ancestor, { recursive: true, force: true });
    }
  });

  it('accepts the clone\'s own graph when the checkout has one', async () => {
    const clone = mkTmp('own');
    mkdirSync(path.join(clone, '.yggdrasil'), { recursive: true });
    try {
      const resolved = await resolveYggRootWithinClone(clone);
      expect(resolved).not.toBeNull();
      // The accepted root is the clone's OWN graph dir, inside the clone.
      expect(resolved).toBe(path.join(path.resolve(clone), '.yggdrasil'));
      expect(resolved!.startsWith(path.resolve(clone))).toBe(true);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it('treats a `.yggdrasil` that is a FILE (not a directory) as non-comparable', async () => {
    const clone = mkTmp('file');
    writeFileSync(path.join(clone, '.yggdrasil'), 'not a directory', 'utf-8');
    try {
      expect(await resolveYggRootWithinClone(clone)).toBeNull();
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it('refuses a `.yggdrasil` SYMLINK that escapes the clone: realpath fires where the lexical check would have passed, no fs op touches the link target', async () => {
    // The symlink hazard: a checked-out commit that committed `.yggdrasil` as a
    // symlink resolving OUTSIDE the clone (into the real repo, or /etc). statSync
    // follows the link, so a purely lexical containment check sees a directory
    // "inside" the clone and waves it through — while every later read/overlay would
    // act on the real target outside. The realpath layer must catch this.
    const clone = mkTmp('symlink-clone');
    const outside = mkTmp('symlink-outside'); // a SIBLING dir, NOT under the clone
    try {
      // A graph + a canary living OUTSIDE the clone — what the escaping link points at.
      const outsideYgg = path.join(outside, '.yggdrasil');
      mkdirSync(outsideYgg, { recursive: true });
      writeFileSync(path.join(outsideYgg, 'yg-config.yaml'), 'version: "5.1.0"\n', 'utf-8');
      const canary = path.join(outside, 'canary.txt');
      const canaryBytes = 'do-not-touch\n';
      writeFileSync(canary, canaryBytes, 'utf-8');

      // The commit's `.yggdrasil` is a SYMLINK escaping the clone.
      const link = path.join(clone, '.yggdrasil');
      symlinkSync(outsideYgg, link, 'dir');

      // findYggRoot follows the link and returns a path LEXICALLY inside the clone.
      const resolved = await findYggRoot(clone);
      expect(resolved).toBe(path.join(path.resolve(clone), '.yggdrasil'));

      // (a) The LEXICAL check would PASS — this is exactly the escape the old
      //     path.relative-only guard let through.
      expect(pathIsWithin(clone, resolved)).toBe(true);
      // (b) The REALPATH check REFUSES — it follows the link to the outside target.
      expect(realpathIsWithin(clone, resolved)).toBe(false);

      // (c) Integrated: the guard returns null → the commit is non-comparable.
      expect(await resolveYggRootWithinClone(clone)).toBeNull();

      // (d) No fs op touched the link target: the canary outside stays byte-unchanged.
      expect(readFileSync(canary, 'utf-8')).toBe(canaryBytes);
    } finally {
      rmSync(clone, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('yg simulate — path-traversal containment (security regression guard)', () => {
  it('isPlainRelativeName accepts plain relative names and rejects traversal / absolute / drive forms', () => {
    for (const ok of ['no-console', 'a-b_c', 'group/sub', 'a.b']) {
      expect(isPlainRelativeName(ok), ok).toBe(true);
    }
    for (const bad of ['../../evil', '..', 'a/../b', '/abs', '\\unc\\x', 'C:\\x', '', '   ']) {
      expect(isPlainRelativeName(bad), bad).toBe(false);
    }
  });

  it('pathIsWithin accepts a destination inside the base and rejects one that escapes it', () => {
    const base = path.join(tmpdir(), 'clone', '.yggdrasil');
    expect(pathIsWithin(base, path.join(base, 'aspects', 'x'))).toBe(true);
    expect(pathIsWithin(base, base)).toBe(true);
    expect(pathIsWithin(base, path.join(base, 'aspects', '..', '..', '..', 'evil'))).toBe(false);
    expect(pathIsWithin(base, path.resolve('/etc/passwd'))).toBe(false);
  });

  it('runSimulation REJECTS a traversing candidate id before any clone or fs mutation — a canary outside stays byte-unchanged', async () => {
    const project = mkTmp('trav-cand');
    // A valid minimal graph, so loadGraphOrAbort would succeed if the input check
    // were bypassed — the rejection must come from input validation, not a load error.
    mkdirSync(path.join(project, '.yggdrasil', 'model', 'app'), { recursive: true });
    writeFileSync(path.join(project, '.yggdrasil', 'yg-config.yaml'), 'version: "5.1.0"\n', 'utf-8');
    // A canary a traversing candidate/overlay could delete if the guard failed.
    const canary = path.join(project, 'canary.txt');
    const canaryBytes = 'do-not-delete\n';
    writeFileSync(canary, canaryBytes, 'utf-8');

    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const emitted: string[] = [];
    try {
      const code = await runSimulation({
        candidateId: '../../../canary.txt',
        target: { kind: 'node', nodePath: 'app' },
        maxCommits: 5,
        cwd: project,
        // A bogus bin path — it must never be reached (rejected before any spawn).
        binPath: path.join(project, 'no-such-bin.js'),
        emit: (s) => emitted.push(s),
      });
      expect(code).toBe(1); // rejected
      expect(emitted.join('')).toBe(''); // no report emitted
      // The canary is byte-for-byte unchanged: the destructive rmSync/cpSync never ran.
      expect(readFileSync(canary, 'utf-8')).toBe(canaryBytes);
      // The structural refusal names the traversal.
      const stderr = errSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderr).toContain('is not a plain relative name');
    } finally {
      errSpy.mockRestore();
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('runSimulation REJECTS a traversing --node path before any clone', async () => {
    const project = mkTmp('trav-node');
    mkdirSync(path.join(project, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(path.join(project, '.yggdrasil', 'yg-config.yaml'), 'version: "5.1.0"\n', 'utf-8');
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await runSimulation({
        candidateId: 'no-console',
        target: { kind: 'node', nodePath: '../../x' },
        maxCommits: 5,
        cwd: project,
        binPath: path.join(project, 'no-such-bin.js'),
        emit: () => {},
      });
      expect(code).toBe(1);
      const stderr = errSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderr).toContain('--node path');
    } finally {
      errSpy.mockRestore();
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('runSimulation REJECTS a traversing --file path before any clone', async () => {
    const project = mkTmp('trav-file');
    mkdirSync(path.join(project, '.yggdrasil', 'model'), { recursive: true });
    writeFileSync(path.join(project, '.yggdrasil', 'yg-config.yaml'), 'version: "5.1.0"\n', 'utf-8');
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await runSimulation({
        candidateId: 'no-console',
        target: { kind: 'file', file: '../../x.ts' },
        maxCommits: 5,
        cwd: project,
        binPath: path.join(project, 'no-such-bin.js'),
        emit: () => {},
      });
      expect(code).toBe(1);
      const stderr = errSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderr).toContain('--file path');
    } finally {
      errSpy.mockRestore();
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('yg simulate — candidate-kind detection (kind inferred from rule source)', () => {
  it('classifies content.md as LLM (unreplayable)', () => {
    const dir = mkTmp('llm');
    writeFileSync(path.join(dir, 'content.md'), '# rule\n', 'utf-8');
    try {
      expect(detectCandidateKind(dir)).toBe('llm');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies content.md + check.mjs as LLM (content.md wins — an LLM companion, unreplayable)', () => {
    const dir = mkTmp('llm-mixed');
    writeFileSync(path.join(dir, 'content.md'), '# rule\n', 'utf-8');
    writeFileSync(path.join(dir, 'check.mjs'), 'export function check() { return []; }\n', 'utf-8');
    try {
      expect(detectCandidateKind(dir)).toBe('llm');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies a bare companion.mjs as companion (unreplayable)', () => {
    const dir = mkTmp('companion');
    writeFileSync(path.join(dir, 'companion.mjs'), 'export function companion() { return []; }\n', 'utf-8');
    try {
      expect(detectCandidateKind(dir)).toBe('companion');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies check.mjs as deterministic (replayable)', () => {
    const dir = mkTmp('det');
    writeFileSync(path.join(dir, 'check.mjs'), 'export function check() { return []; }\n', 'utf-8');
    try {
      expect(detectCandidateKind(dir)).toBe('deterministic');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies an aspect with no rule source as none (nothing to replay)', () => {
    const dir = mkTmp('none');
    writeFileSync(path.join(dir, 'yg-aspect.yaml'), 'name: agg\nimplies: [x]\n', 'utf-8');
    try {
      expect(detectCandidateKind(dir)).toBe('none');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('yg simulate — schema version read', () => {
  it('reads a quoted version', () => {
    const dir = mkTmp('ver');
    writeFileSync(path.join(dir, 'yg-config.yaml'), 'version: "5.1.0"\nreviewer:\n  tiers: {}\n', 'utf-8');
    try {
      expect(readConfigVersion(dir)).toBe('5.1.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads an unquoted version', () => {
    const dir = mkTmp('ver2');
    writeFileSync(path.join(dir, 'yg-config.yaml'), 'version: 5.0.0\n', 'utf-8');
    try {
      expect(readConfigVersion(dir)).toBe('5.0.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when there is no version line', () => {
    const dir = mkTmp('nover');
    writeFileSync(path.join(dir, 'yg-config.yaml'), 'reviewer:\n  tiers: {}\n', 'utf-8');
    try {
      expect(readConfigVersion(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the config file is absent', () => {
    const dir = mkTmp('nocfg');
    try {
      expect(readConfigVersion(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('yg simulate — per-commit run classification', () => {
  it('classifies a satisfied run as ran-clean', () => {
    const r = classifyAspectTestRun(0, 'yg aspect-test: satisfied — No violations.\n', '');
    expect(r).toEqual({ kind: 'ran-clean' });
  });

  it('classifies a refused run as violations with the reported count', () => {
    const r = classifyAspectTestRun(1, 'yg aspect-test: refused — 3 violations\nsome detail\n', '');
    expect(r).toEqual({ kind: 'violations', count: 3 });
  });

  it('classifies a single-violation refusal', () => {
    const r = classifyAspectTestRun(1, 'yg aspect-test: refused — 1 violation\n', '');
    expect(r).toEqual({ kind: 'violations', count: 1 });
  });

  it('classifies a run with no verdict stamp as non-comparable, surfacing the error reason', () => {
    const r = classifyAspectTestRun(1, '', "Error: Node 'x/y' not found.\nRun 'yg tree'.\n");
    expect(r.kind).toBe('non-comparable');
    if (r.kind === 'non-comparable') {
      expect(r.reason).toContain("Node 'x/y' not found.");
      expect(r.reason).not.toContain('Error:');
    }
  });
});

describe('yg simulate — --max-commits parsing', () => {
  it('accepts a positive integer', () => {
    expect(parseMaxCommits('20')).toBe(20);
    expect(parseMaxCommits('1')).toBe(1);
    expect(parseMaxCommits('  7 ')).toBe(7);
  });

  it('rejects zero, negatives, and non-numeric input', () => {
    expect(parseMaxCommits('0')).toBeNull();
    expect(parseMaxCommits('-3')).toBeNull();
    expect(parseMaxCommits('abc')).toBeNull();
    expect(parseMaxCommits('')).toBeNull();
    expect(parseMaxCommits('3.5')).toBeNull();
  });
});

describe('yg simulate — report rendering', () => {
  const outcomes: CommitOutcome[] = [
    { sha: 'aaaaaaaa1111', subject: 'preinit no graph', kind: 'non-comparable', reason: 'this commit has no graph of its own' },
    { sha: 'bbbbbbbb2222', subject: 'add violation', kind: 'violations', count: 2 },
    { sha: 'cccccccc3333', subject: 'schema downgrade', kind: 'non-comparable', reason: 'schema 5.0.0, not 5.1.0' },
    { sha: 'dddddddd4444', subject: 'clean fix', kind: 'ran-clean' },
  ];

  const NODE_TARGET: SimulateTarget = { kind: 'node', nodePath: 'app' };

  it('prints the verbatim Wald label', () => {
    const out = renderReport({ candidateId: 'no-console', target: NODE_TARGET, referenceSchema: '5.1.0', outcomes });
    expect(out).toContain(WALD_LABEL);
    expect(WALD_LABEL).toBe(
      'history is censored by the old regime — a tightening replay is a LOWER bound on true catches, a loosening replay an UPPER bound.',
    );
  });

  it('lists every outcome token and a summary count line', () => {
    const out = renderReport({ candidateId: 'no-console', target: NODE_TARGET, referenceSchema: '5.1.0', outcomes });
    expect(out).toContain('ran-clean');
    expect(out).toContain('violations (2)');
    expect(out).toContain('non-comparable');
    // Summary counts (2 non-comparable, 1 violations, 1 ran-clean).
    expect(out).toContain('ran-clean 1');
    expect(out).toContain('violations 1');
    expect(out).toContain('non-comparable 2');
    // The horizon schema and candidate/node are named in the header.
    expect(out).toContain('5.1.0');
    expect(out).toContain('no-console');
    expect(out).toContain('app');
  });

  it('renders the empty-history case without throwing', () => {
    const out = renderReport({ candidateId: 'no-console', target: NODE_TARGET, referenceSchema: '5.1.0', outcomes: [] });
    expect(out).toContain('No commits to replay');
    expect(out).toContain(WALD_LABEL);
  });

  it('--file target names the file (not "node") and states plainly that the rule/attachment are TODAY while the code is history', () => {
    const fileTarget: SimulateTarget = { kind: 'file', file: 'src/leaf/a.ts' };
    const out = renderReport({ candidateId: 'no-console', target: fileTarget, referenceSchema: '5.1.0', outcomes });
    expect(out).toContain('src/leaf/a.ts');
    expect(out.toLowerCase()).toMatch(/rule.*today|today.*rule/);
    expect(out.toLowerCase()).toContain('history');
  });
});

describe('yg simulate — overlayCurrentArchitectureAndCoverage (--file target)', () => {
  function mkYggRoot(label: string): string {
    const root = mkTmp(label);
    const yggRoot = path.join(root, '.yggdrasil');
    mkdirSync(yggRoot, { recursive: true });
    return yggRoot;
  }

  it('copies the current yg-architecture.yaml wholesale into the clone', () => {
    const real = mkYggRoot('overlay-real');
    const clone = mkYggRoot('overlay-clone');
    try {
      writeFileSync(path.join(real, 'yg-architecture.yaml'), 'node_types:\n  leaf:\n    description: today\n', 'utf-8');
      writeFileSync(path.join(clone, 'yg-architecture.yaml'), 'node_types:\n  leaf:\n    description: historical\n', 'utf-8');
      overlayCurrentArchitectureAndCoverage(real, clone);
      expect(readFileSync(path.join(clone, 'yg-architecture.yaml'), 'utf-8')).toContain('today');
    } finally {
      rmSync(path.dirname(real), { recursive: true, force: true });
      rmSync(path.dirname(clone), { recursive: true, force: true });
    }
  });

  it('replaces the coverage: block in yg-config.yaml with the current one, preserving the clone\'s OWN version: and other keys', () => {
    const real = mkYggRoot('overlay-real2');
    const clone = mkYggRoot('overlay-clone2');
    try {
      writeFileSync(
        path.join(real, 'yg-config.yaml'),
        'version: "5.9.0"\ncoverage:\n  required:\n    - src/\n  excluded: []\n  type_level: true\n',
        'utf-8',
      );
      writeFileSync(
        path.join(clone, 'yg-config.yaml'),
        'version: "5.2.0"\ncoverage:\n  required: []\n  excluded: []\n  type_level: false\ndebug: false\n',
        'utf-8',
      );
      overlayCurrentArchitectureAndCoverage(real, clone);
      const spliced = readFileSync(path.join(clone, 'yg-config.yaml'), 'utf-8');
      // The clone's OWN schema version (already verified equal to today's by the
      // caller BEFORE this overlay runs) and other keys survive untouched.
      expect(spliced).toContain('version: "5.2.0"');
      expect(spliced).toContain('debug: false');
      // The coverage settings are TODAY's, not the clone's historical ones.
      expect(spliced).toContain('type_level: true');
      expect(spliced).not.toContain('type_level: false');
      expect(spliced).toContain('src/');
    } finally {
      rmSync(path.dirname(real), { recursive: true, force: true });
      rmSync(path.dirname(clone), { recursive: true, force: true });
    }
  });

  it('appends a coverage: block when the clone has none at all', () => {
    const real = mkYggRoot('overlay-real3');
    const clone = mkYggRoot('overlay-clone3');
    try {
      writeFileSync(path.join(real, 'yg-config.yaml'), 'version: "5.9.0"\ncoverage:\n  type_level: true\n', 'utf-8');
      writeFileSync(path.join(clone, 'yg-config.yaml'), 'version: "5.2.0"\n', 'utf-8');
      overlayCurrentArchitectureAndCoverage(real, clone);
      const spliced = readFileSync(path.join(clone, 'yg-config.yaml'), 'utf-8');
      expect(spliced).toContain('version: "5.2.0"');
      expect(spliced).toContain('type_level: true');
    } finally {
      rmSync(path.dirname(real), { recursive: true, force: true });
      rmSync(path.dirname(clone), { recursive: true, force: true });
    }
  });

  it('fails closed (throws) rather than silently writing when the clone .yggdrasil does not exist', () => {
    const real = mkYggRoot('overlay-real4');
    const outside = mkTmp('overlay-outside');
    try {
      writeFileSync(path.join(real, 'yg-architecture.yaml'), 'node_types: {}\n', 'utf-8');
      const nonexistentClone = path.join(outside, 'does-not-exist', '.yggdrasil');
      expect(() => overlayCurrentArchitectureAndCoverage(real, nonexistentClone)).toThrow();
    } finally {
      rmSync(path.dirname(real), { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
