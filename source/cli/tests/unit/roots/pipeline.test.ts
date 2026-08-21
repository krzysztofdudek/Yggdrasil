import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAndExtractAll, runRootsIndex } from '../../../src/roots/pipeline.js';
import * as nodeTypesModule from '../../../src/ast/node-types.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/pipeline.test.ts — the async composition: `parseAndExtractAll`
// (walk + filter + parse + extract, §6.1's robustness rules) and the full
// `runRootsIndex` chain over a REAL tmp-dir mini-repo (no git needed — R1-R3
// mines with no history join at all). Real fixture files on disk, no mocks
// except spying on `readNodeTypes` to prove the per-grammar-per-process
// binding cache actually fires (a call-count assertion needs a spy; the
// derivation's correctness is `binding.test.ts`'s concern, not this file's).
// ---------------------------------------------------------------------------

async function withTmpRepo<T>(files: Record<string, string>, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-roots-pipeline-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, 'utf-8');
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('parseAndExtractAll — §6.1 robustness: oversize exclusion and malformed-file tolerance', () => {
  it('a file exceeding history.blobMaxBytes is EXCLUDED before parsing — no scopes at all, not even the file scope', async () => {
    const config = await defaultRootsConfig('history:\n    blobMaxBytes: 20\n'); // trivially small — any real file exceeds it
    await withTmpRepo({ 'src/a.ts': 'function greet() { return 1; }\n' }, async (dir) => {
      const { rawScopes } = await parseAndExtractAll(dir, config);
      expect(rawScopes).toHaveLength(0);
    });
  });

  it('a malformed file never aborts the pipeline — it yields its file scope only (extractUnits\' own §6.1 error-tolerance contract, which this pipeline composes rather than re-implements)', async () => {
    const config = await defaultRootsConfig();
    await withTmpRepo(
      {
        'src/broken.ts': 'function broken( { return; // unbalanced — a real syntax error, not an exotic one\n',
        'src/clean.ts': 'function fine() { return 1; }\n',
      },
      async (dir) => {
        const { rawScopes } = await parseAndExtractAll(dir, config);
        const brokenScopes = rawScopes.filter((s) => s.relPath === 'src/broken.ts');
        expect(brokenScopes).toHaveLength(1);
        expect(brokenScopes[0].kind).toBe('file');
        // The clean sibling is unaffected — one file scope plus its one method.
        const cleanScopes = rawScopes.filter((s) => s.relPath === 'src/clean.ts');
        expect(cleanScopes.map((s) => s.kind).sort()).toEqual(['file', 'method']);
      },
    );
  });

  it('files excluded by §6.8\'s built-in exclusions or an unregistered extension never enter rawScopes at all', async () => {
    const config = await defaultRootsConfig();
    await withTmpRepo(
      {
        'src/real.ts': 'function f() { return 1; }\n',
        'node_modules/pkg/index.ts': 'function ignored() { return 1; }\n',
        'README.md': '# not a registered grammar\n',
      },
      async (dir) => {
        const { rawScopes } = await parseAndExtractAll(dir, config);
        expect(rawScopes.some((s) => s.relPath.includes('node_modules'))).toBe(false);
        expect(rawScopes.some((s) => s.relPath === 'README.md')).toBe(false);
        expect(rawScopes.some((s) => s.relPath === 'src/real.ts')).toBe(true);
      },
    );
  });
});

describe('parseAndExtractAll — forParsing\'s mining-only test-pattern exclusion (spec §6.8\'s closing clause, REWORK mutation-kill M18)', () => {
  it('a *.test.ts file passes the marker-scan (forMarkers) listing but NEVER reaches rawScopes — the parse-set filter (forParsing) drops it before parsing, golden-shaped', async () => {
    const config = await defaultRootsConfig();
    await withTmpRepo(
      {
        'src/real.ts': 'function f() { return 1; }\n',
        'src/real.test.ts': 'function shouldNeverMine() { return 1; }\n',
        'src/real.spec.ts': 'function alsoNeverMines() { return 1; }\n',
      },
      async (dir) => {
        const { files, rawScopes } = await parseAndExtractAll(dir, config);
        // The marker-scan listing (forMarkers only, no test-pattern clause)
        // DOES include the test files — proving the exclusion is specific to
        // forParsing, not a blanket walk-time drop.
        expect(files).toContain('src/real.test.ts');
        expect(files).toContain('src/real.spec.ts');
        // But rawScopes — which additionally applies forParsing — carries
        // NOTHING from either test-pattern file, through the parse filter.
        expect(rawScopes.some((s) => s.relPath === 'src/real.test.ts')).toBe(false);
        expect(rawScopes.some((s) => s.relPath === 'src/real.spec.ts')).toBe(false);
        expect(rawScopes.some((s) => s.relPath === 'src/real.ts')).toBe(true);
      },
    );
  });
});

describe('binding cache — one derivation per grammar per process (spec §6.2, normative)', () => {
  it('readNodeTypes is called at most once for a given grammar across multiple parseAndExtractAll calls in this process', async () => {
    const spy = vi.spyOn(nodeTypesModule, 'readNodeTypes');
    const callsBefore = spy.mock.calls.filter((c) => c[0] === 'python').length;
    const config = await defaultRootsConfig();
    await withTmpRepo({ 'src/a.py': 'def f():\n    return 1\n' }, (dir) => parseAndExtractAll(dir, config));
    await withTmpRepo({ 'src/b.py': 'def g():\n    return 2\n' }, (dir) => parseAndExtractAll(dir, config));
    const callsAfter = spy.mock.calls.filter((c) => c[0] === 'python').length;
    // At most ONE new 'python' derivation across both calls — the second
    // repo's own python file must reuse the first call's cached binding.
    expect(callsAfter - callsBefore).toBeLessThanOrEqual(1);
    spy.mockRestore();
  });
});

/**
 * Generates a scripted, real corpus over `PARTITION_SCOPE_FLOOR`'s 300-scope
 * denominator (named-body + file raw scopes) — a loop of small, honest
 * files, per Task 7's own "scripted-builder job, not hand-typing" guidance,
 * reused here at unit scale for one genuine end-to-end pin. Every function
 * calls `logger.info(...)` — a deliberately universal behavior for a real,
 * easily-accepted convention under default config. Arity ALTERNATES (0 vs 1
 * param) so it does NOT perfectly correlate with the call convention — two
 * surfaces with IDENTICAL conform sets are §9.4e's own dedup target (this
 * corpus's first draft made every surface collapse into one fact for
 * exactly that reason); this shape lets the call convention stand on its
 * own conform set.
 */
function scriptedCorpus(fileCount: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < fileCount; i++) {
    const lines = ["import { logger } from './logger.js';", ''];
    for (let k = 0; k < 5; k++) {
      if (k % 2 === 0) {
        lines.push(`export function handler${i}_${k}() {`);
        lines.push('  logger.info("x");');
        lines.push('  return 1;');
      } else {
        lines.push(`export function handler${i}_${k}(x: number) {`);
        lines.push('  logger.info("x");');
        lines.push('  return x;');
      }
      lines.push('}');
      lines.push('');
    }
    files[`src/mod${i}/file${i}.ts`] = lines.join('\n');
  }
  files['src/logger.ts'] = 'export const logger = { info: (_m: string) => {} };\n';
  return files;
}

describe('runRootsIndex — full pipeline over a real tmp-dir mini-repo (no git needed — R1-R3 mines with no history)', () => {
  it('succeeds, mines a genuine convention, and is byte-shape-stable (header fields aside) across two runs', async () => {
    const config = await defaultRootsConfig();
    await withTmpRepo(scriptedCorpus(65), async (dir) => {
      const first = await runRootsIndex(dir, config, []);
      expect(first.body.partitions.length).toBeGreaterThan(0);
      const allFacts = first.body.partitions.flatMap((p) => p.facts);
      expect(allFacts.some((f) => f.surface === 'auto.call:logger.info')).toBe(true);
      expect(typeof first.bindingSetHash).toBe('string');
      expect(first.bindingSetHash.length).toBeGreaterThan(0);
      expect(typeof first.candidateCountLog2).toBe('number');

      const second = await runRootsIndex(dir, config, []);
      expect(second.body).toEqual(first.body);
      expect(second.bindingSetHash).toBe(first.bindingSetHash);
      expect(second.candidateCountLog2).toBe(first.candidateCountLog2);
    });
  });

  it('an empty repo (well under the 300-scope floor) mines silently — zero partitions, no crash (spec J4)', async () => {
    const config = await defaultRootsConfig();
    await withTmpRepo({ 'src/a.ts': 'function f() { return 1; }\n' }, async (dir) => {
      const result = await runRootsIndex(dir, config, []);
      expect(result.body.partitions).toEqual([]);
    });
  });

  it('the 3-arg form (no options at all) mines at the constant noLifecycleWeight 0.3, with no history-fed field on the body — the degraded default when no history is wired in', async () => {
    const config = await defaultRootsConfig();
    await withTmpRepo(scriptedCorpus(65), async (dir) => {
      const result = await runRootsIndex(dir, config, []); // no third argument at all — never even an empty options object
      // `historyStats`/`cochange`/`aliases` are STRUCTURALLY ABSENT (the key
      // itself is missing, not defaulted) — `MinedModel`'s own degraded-mode
      // contract (D4, D9's sibling doctrine) — while `agentShare` is ALWAYS
      // present, `null` for "no history" (§18.4's own "n/a" encoding).
      expect('historyStats' in result.body).toBe(false);
      expect('cochange' in result.body).toBe(false);
      expect('aliases' in result.body).toBe(false);
      expect(result.body.agentShare).toBeNull();

      // The constant weight itself, made observable: every one of
      // `scriptedCorpus`'s 325 handler functions calls `logger.info`, so the
      // accepted `auto.call:logger.info` fact's weighted count is exactly
      // 325 x 0.3 = 97.5 (canonical decimal) — a wrong constant, or a
      // silently-wired `surfaceWeightFn`, would move this number.
      const fact = result.body.partitions.flatMap((p) => p.facts).find((f) => f.surface === 'auto.call:logger.info');
      expect(fact).toBeDefined();
      expect(fact?.counts.true).toBe('97.5');
      // No AgeFn ⇒ fail-closed: nothing ever survives, so every fact's
      // survived-raw population is empty and nothing is hook-eligible.
      expect(fact?.nTotalRaw).toBe(0);
      expect(fact?.hookEligible).toBe(false);
    });
  });

  it('bindingSetHash is insertion-order independent (REWORK mutation-kill M16): two repos using the SAME grammar set, discovered in OPPOSITE order, hash identically', async () => {
    const config = await defaultRootsConfig();
    // Repo A: alphabetically, the Python file is walked before the TS file.
    // Repo B: the same two grammars, TS before Python — the OPPOSITE
    // discovery order feeding `usedAssetHashes`' build loop in `pipeline.ts`.
    // `JSON.stringify(usedAssetHashes, Object.keys(usedAssetHashes).sort())`
    // uses its array-replacer argument to fix the KEY ORDER regardless of
    // insertion order — this pins that property against a live corpus, not
    // just the string-building call in isolation.
    const hashA = await withTmpRepo(
      { 'src/a_first.py': 'def f():\n    return 1\n', 'src/z_second.ts': 'function g() { return 1; }\n' },
      async (dir) => (await runRootsIndex(dir, config, [])).bindingSetHash,
    );
    const hashB = await withTmpRepo(
      { 'src/a_first.ts': 'function g() { return 1; }\n', 'src/z_second.py': 'def f():\n    return 1\n' },
      async (dir) => (await runRootsIndex(dir, config, [])).bindingSetHash,
    );
    expect(hashA).toBe(hashB);
  });
});
