/**
 * Integration tests for the SILENT feature-field index through the REAL relation pass.
 *
 * Covers, against a real on-disk graph (real `.yggdrasil/` + real source):
 *   - the reporting path (`writeFeatureIndex: true`) writes a sparse `.feature-field.json`
 *     whose `contentHash` for a file EQUALS the pass's own content hash AND what a reader
 *     re-derives from the file bytes (the slice-3 match key),
 *   - `generatedAt` comes from the INJECTED clock (deterministic),
 *   - the writer self-ensures the gitignore line,
 *   - the four other `runCheck` call sites stay byproduct-free (portal, a fill's real
 *     re-check, a fill's dry-run re-check, and a plain read with no flag write NO index),
 *   - the write is best-effort (a write failure is swallowed, never throws, no partial file).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { loadGraph } from '../../src/core/graph-loader.js';
import { runCheck, runAttentionDump } from '../../src/core/check.js';
import { runFill } from '../../src/core/fill.js';
import { runPortalCheck } from '../../src/portal/engine-api.js';
import { runRelationPass } from '../../src/relations/pass.js';
import { extractorForLanguage } from '../../src/relations/extractors/registry.js';
import { makeResolvePathToFile } from '../../src/relations/resolve-path.js';
import { astCacheDir } from '../../src/relations/facts-cache.js';
import { hashString } from '../../src/io/hash.js';
import {
  writeFeatureIndex,
  familyKey,
  FEATURE_FIELD_FILENAME,
  type FeatureFieldIndex,
} from '../../src/core/feature-index-write.js';
import type { Graph } from '../../src/model/graph.js';

function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/** A TypeScript file with exactly `n` `if` statements (branch-like count == n), otherwise
 *  identical structure — so branch-like has controlled spread and a controlled outlier. */
function tsFileWithIfs(n: number): string {
  const lines = ['export function f(): number {'];
  for (let i = 0; i < n; i++) lines.push(`  if (globalThis) { return ${i}; }`);
  lines.push('  return -1;');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

const OUTLIER_PATH = 'src/svc/file5.ts';
const INDEX_REL = path.join('.yggdrasil', FEATURE_FIELD_FILENAME);
/** The svc fixture's six tracked source files (the graph-governed universe passed to runCheck). */
const SVC_TRACKED = [0, 1, 2, 3, 4, 5].map((i) => `src/svc/file${i}.ts`);

describe('feature-field index — real pass, byproduct-free elsewhere, best-effort', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'feat-field-'));
    // Single mapping-capable `service` type. No relations declared and no cross-file
    // imports, so the relation-conformance check stays clean.
    w(
      root,
      '.yggdrasil/yg-architecture.yaml',
      `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`,
    );
    // A reviewer tier so runFill has a configured reviewer (never invoked — no LLM aspect).
    w(
      root,
      '.yggdrasil/yg-config.yaml',
      `reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n`,
    );
    // One node owning six same-language files: five "normal" (few branches) + one outlier.
    w(root, '.yggdrasil/model/svc/yg-node.yaml', `name: Svc\ndescription: service unit\ntype: service\nmapping:\n  - src/svc\n`);
    const ifCounts = [1, 2, 3, 2, 1, 40]; // file5 is the branch-like outlier
    ifCounts.forEach((n, i) => w(root, `src/svc/file${i}.ts`, tsFileWithIfs(n)));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const indexAbs = (): string => path.join(root, INDEX_REL);
  const readIndex = (): FeatureFieldIndex => JSON.parse(readFileSync(indexAbs(), 'utf-8')) as FeatureFieldIndex;

  it('reporting path writes a sparse index; contentHash equals the pass hash AND the file-bytes hash', async () => {
    const graph = await loadGraph(root);

    // The pass's own content hash for the outlier file (what it keys the cache on).
    const relResult = await runRelationPass(graph, path.dirname(graph.rootPath), {
      extractorFor: extractorForLanguage,
      resolvePathToFile: makeResolvePathToFile(path.dirname(graph.rootPath)),
      symbolIndexDir: astCacheDir(graph.rootPath),
    });
    const passHash = relResult.hashByPath.get(OUTLIER_PATH);
    expect(passHash).toBeTruthy();

    // Reporting path: writeFeatureIndex requested with a pinned clock, scoped to the tracked set.
    await runCheck(graph, SVC_TRACKED, {
      writeFeatureIndex: true,
      now: () => new Date('2026-07-05T09:00:00.000Z'),
    });

    expect(existsSync(indexAbs())).toBe(true);
    const index = readIndex();
    expect(index.v).toBe(1);
    expect(index.generatedAt).toBe('2026-07-05T09:00:00.000Z'); // injected clock

    // Sparse: ONLY the outlier file is flagged (the five near-uniform files are not).
    expect(Object.keys(index.files)).toEqual([OUTLIER_PATH]);
    const entry = index.files[OUTLIER_PATH];

    // Family = owner node × extractor language.
    expect(entry.family).toBe(familyKey('svc', 'typescript'));
    // At least the branch-like dimension is flagged.
    expect(entry.deviations.map((d) => d.dim)).toContain('branch-like');
    expect(entry.deviations.length).toBeGreaterThan(0);

    // contentHash is the SAME value the pass computed AND what a reader re-derives from bytes.
    const bytesHash = hashString(readFileSync(path.join(root, OUTLIER_PATH), 'utf-8'));
    expect(entry.contentHash).toBe(passHash);
    expect(entry.contentHash).toBe(bytesHash);
  });

  it('self-ensures the .feature-field.json gitignore line on write', async () => {
    const graph = await loadGraph(root);
    // No .yggdrasil/.gitignore exists in this hand-built fixture yet.
    expect(existsSync(path.join(root, '.yggdrasil', '.gitignore'))).toBe(false);

    await runCheck(graph, SVC_TRACKED, { writeFeatureIndex: true, now: () => new Date() });

    const gi = readFileSync(path.join(root, '.yggdrasil', '.gitignore'), 'utf-8');
    expect(gi.split('\n').map((l) => l.trim())).toContain(FEATURE_FIELD_FILENAME);
  });

  it('a plain read (no flag) writes NO index', async () => {
    const graph = await loadGraph(root);
    await runCheck(graph, null); // no options → writeFeatureIndex defaults false
    expect(existsSync(indexAbs())).toBe(false);
  });

  it('the portal check writes NO index (byproduct-free call site)', async () => {
    const graph = await loadGraph(root);
    await runPortalCheck(graph, [], () => new Date());
    expect(existsSync(indexAbs())).toBe(false);
  });

  it("a fill's real internal re-check writes NO index (byproduct-free call site)", async () => {
    const graph = await loadGraph(root);
    await runFill(graph, { coverageVisibleFiles: null, write: () => {} });
    expect(existsSync(indexAbs())).toBe(false);
  });

  it("a fill's dry-run internal re-check writes NO index (byproduct-free call site)", async () => {
    const graph = await loadGraph(root);
    await runFill(graph, { coverageVisibleFiles: null, dryRun: true, write: () => {} });
    expect(existsSync(indexAbs())).toBe(false);
  });

  it("a real fill with writeFeatureIndex:true maintains the index on its post-fill report", async () => {
    const graph = await loadGraph(root);
    await runFill(graph, {
      coverageVisibleFiles: SVC_TRACKED,
      write: () => {},
      writeFeatureIndex: true,
      featureIndexNow: () => new Date('2026-07-05T09:00:00.000Z'),
    });
    // The `--approve` reporting path (fill's real post-fill runCheck) writes the index.
    expect(existsSync(indexAbs())).toBe(true);
    const index = readIndex();
    expect(index.generatedAt).toBe('2026-07-05T09:00:00.000Z'); // injected clock threaded through the fill
    expect(Object.keys(index.files)).toEqual([OUTLIER_PATH]); // sparse
  });

  it("a dry-run fill even WITH writeFeatureIndex:true writes NO index (returns before the report)", async () => {
    const graph = await loadGraph(root);
    await runFill(graph, {
      coverageVisibleFiles: SVC_TRACKED, // a valid tracked set, so the ONLY reason nothing is written is the dry-run early return
      dryRun: true,
      write: () => {},
      writeFeatureIndex: true,
      featureIndexNow: () => new Date(),
    });
    expect(existsSync(indexAbs())).toBe(false); // dry-run's re-check is byproduct-free regardless of the flag
  });

  it('is best-effort: a write failure is swallowed (no throw, no partial file)', async () => {
    // Point rootPath under a regular FILE so every directory creation fails (ENOTDIR).
    const bogusParent = path.join(root, 'not-a-dir');
    writeFileSync(bogusParent, 'x', 'utf-8');
    const badGraph = {
      rootPath: path.join(bogusParent, 'sub'), // parent is a file → mkdir fails
      nodes: new Map(),
    } as unknown as Graph;

    await expect(
      writeFeatureIndex(badGraph, new Map(), new Map(), new Set(), { now: () => new Date() }),
    ).resolves.toBeUndefined();
    expect(existsSync(path.join(bogusParent, 'sub', FEATURE_FIELD_FILENAME))).toBe(false);
  });

  it('scopes to the tracked set: an owned file NOT in coverageVisibleFiles is excluded from the index', async () => {
    const graph = await loadGraph(root);
    // Omit the outlier from the tracked set (it is owned by svc but "gitignored/scratch").
    const trackedWithoutOutlier = SVC_TRACKED.filter((p) => p !== OUTLIER_PATH);
    await runCheck(graph, trackedWithoutOutlier, { writeFeatureIndex: true, now: () => new Date() });

    expect(existsSync(indexAbs())).toBe(true); // the index is still written…
    expect(Object.keys(readIndex().files)).not.toContain(OUTLIER_PATH); // …but never mentions the untracked file
  });

  it('writes NO index when coverageVisibleFiles is null (honest scoping — unknown ≠ unfiltered)', async () => {
    const graph = await loadGraph(root);
    await runCheck(graph, null, { writeFeatureIndex: true, now: () => new Date() });
    expect(existsSync(indexAbs())).toBe(false);
  });

  it('appends the gitignore line once to a pre-existing file and no-ops when present', async () => {
    // A .yggdrasil/.gitignore already exists WITHOUT the feature-field line.
    writeFileSync(path.join(root, '.yggdrasil', '.gitignore'), 'node_modules/\n', 'utf-8');
    const graph = await loadGraph(root);

    await runCheck(graph, SVC_TRACKED, { writeFeatureIndex: true, now: () => new Date() });
    await runCheck(graph, SVC_TRACKED, { writeFeatureIndex: true, now: () => new Date() }); // second call: no-op branch

    const gi = readFileSync(path.join(root, '.yggdrasil', '.gitignore'), 'utf-8');
    expect(gi).toContain('node_modules/'); // pre-existing content preserved
    const occurrences = gi.split('\n').filter((l) => l.trim() === FEATURE_FIELD_FILENAME).length;
    expect(occurrences).toBe(1); // appended once, never duplicated
  });
});

describe('runAttentionDump — in-process calibration view (writes nothing)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'attn-dump-'));
    w(root, '.yggdrasil/yg-architecture.yaml', `node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: "**"\n`);
    w(root, '.yggdrasil/yg-config.yaml', `reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n`);
    // A ≥ MIN_N family with one outlier, plus a below-MIN_N family (exercises the too-few note).
    w(root, '.yggdrasil/model/svc/yg-node.yaml', `name: Svc\ndescription: service unit\ntype: service\nmapping:\n  - src/svc\n`);
    [1, 2, 3, 2, 1, 40].forEach((n, i) => w(root, `src/svc/file${i}.ts`, tsFileWithIfs(n)));
    w(root, '.yggdrasil/model/tiny/yg-node.yaml', `name: Tiny\ndescription: tiny unit\ntype: service\nmapping:\n  - src/tiny\n`);
    [1, 2].forEach((n, i) => w(root, `src/tiny/t${i}.ts`, tsFileWithIfs(n)));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** The svc+tiny fixture's tracked source files (the graph-governed universe the CLI passes in). */
  const ATTN_TRACKED = [
    ...[0, 1, 2, 3, 4, 5].map((i) => `src/svc/file${i}.ts`),
    'src/tiny/t0.ts',
    'src/tiny/t1.ts',
  ];

  it('surfaces outliers in plain language, notes too-few families, and prints no statistics jargon', async () => {
    const dump = await runAttentionDump(await loadGraph(root), ATTN_TRACKED);

    // The outlier is surfaced in plain words, grouped by node and language.
    expect(dump).toContain('svc · typescript');
    expect(dump).toContain('src/svc/file5.ts');
    expect(dump).toMatch(/worth a closer read/);
    // The below-MIN_N family prints its raw vectors but is annotated, nothing flagged.
    expect(dump).toContain('tiny · typescript');
    expect(dump).toContain('too few files');
    // No statistics jargon leaks into the user-facing text.
    const lc = dump.toLowerCase();
    expect(lc).not.toContain('z-score');
    expect(lc).not.toContain('mad');
    expect(lc).not.toContain('percentile');
    // It writes nothing.
    expect(existsSync(path.join(root, '.yggdrasil', FEATURE_FIELD_FILENAME))).toBe(false);
  });

  it('scopes the dump to the tracked set: an owned but untracked file never appears', async () => {
    // Omit the outlier from the tracked set — it must be absent from the dump entirely.
    const dump = await runAttentionDump(
      await loadGraph(root),
      ATTN_TRACKED.filter((p) => p !== 'src/svc/file5.ts'),
    );
    expect(dump).not.toContain('src/svc/file5.ts');
    // The "→ worth a closer read:" flag line only appears when a file is flagged; removing the
    // outlier leaves nothing flagged (the header explanation of the phrase is unaffected).
    expect(dump).not.toContain('→ worth a closer read');
  });

  it('reports nothing to compare when no node owns parsed source', async () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'attn-bare-'));
    try {
      w(bare, '.yggdrasil/yg-architecture.yaml', `node_types:\n  doc:\n    description: 'docs'\n    log_required: false\n    when:\n      path: "**"\n`);
      w(bare, '.yggdrasil/yg-config.yaml', `reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n`);
      // A node mapping only a non-source file → no parsed facts → no families.
      w(bare, '.yggdrasil/model/docs/yg-node.yaml', `name: Docs\ndescription: docs\ntype: doc\nmapping:\n  - README.md\n`);
      w(bare, 'README.md', '# hi\n');
      const dump = await runAttentionDump(await loadGraph(bare), ['README.md']);
      expect(dump).toContain('nothing to compare');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('builds its own resolvePathToFile through the exclusion-guarded constructor, like every other resolver this run', () => {
    // A resolver built with a raw, unguarded owner index can decide a Go/Java
    // package's ownership over files an exclusion should have dropped from
    // consideration first (relations/resolve-path.ts's own doc comment). This
    // is a source-text pin, not a behavioral one, because runAttentionDump's
    // own body (verified just above by reading the same file this checks)
    // reads ONLY relResult.factsByPath / relResult.hashByPath — populated by
    // the pass's file ENUMERATION, never relResult.violationsByNode, which is
    // the only field resolvePathToFile's guardedness could ever change. No
    // fixture can make the dump's OWN printed text differ between a guarded
    // and an unguarded construction, so there is nothing to observe from the
    // outside; reading the shipped source is what pins the actual production
    // wiring instead.
    const checkSrc = readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'check.ts'), 'utf-8');
    const attnDumpSrc = checkSrc.slice(checkSrc.indexOf('export async function runAttentionDump'));
    expect(attnDumpSrc).not.toMatch(/resolvePathToFile:\s*makeResolvePathToFile\(/);
    expect(attnDumpSrc).toMatch(/resolvePathToFile:\s*await guardedResolve\(/);
    expect(attnDumpSrc).not.toContain('violationsByNode');
  });
});
