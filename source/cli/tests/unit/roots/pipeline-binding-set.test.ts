import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runRootsIndex, computeUsedGrammarSetHash } from '../../../src/roots/pipeline.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/pipeline-binding-set.test.ts — pins the property
// `pipeline.ts`'s own bindingSetHash fold documents at length but which no
// other test could catch being deleted (the whole-increment review proved the
// mutant survives every suite): the fold covers THIS run's used grammars,
// re-derived from the parse set, never the process-lifetime `bindingCache`.
// The cache is warm across `runRootsIndex` calls in one process — the golden
// suites, the portal, or a future daemon can index many repositories without
// restarting — so folding the cache instead would make a repository's
// bindingSetHash depend on whatever OTHER repositories the process indexed
// first. Sibling file to pipeline.test.ts on purpose: new pins go in new
// files, never by growing an existing LLM-reviewed file toward the prompt
// ceiling.
// ---------------------------------------------------------------------------

async function withTmpRepo<T>(files: Record<string, string>, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-roots-binding-set-'));
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

const TS_ONLY = { 'src/a.ts': 'function g() { return 1; }\n' };
const PY_ONLY = { 'src/a.py': 'def f():\n    return 1\n' };

describe('bindingSetHash folds this run\'s used grammars, never the process-lifetime binding cache', () => {
  it('a repository\'s bindingSetHash is identical whether the cache is cold or carries another repository\'s grammars — and two repos with different grammar sets never share a hash (mutation-kill: folding `bindingCache` instead of the per-run parse set makes the third index below inherit the python grammar from the second and drift from the first)', async () => {
    const config = await defaultRootsConfig();
    // What this test pins, precisely: the fold is RUN-SCOPED (this run's own
    // used-grammar set), so warmth left behind by an EARLIER run in the same
    // process never leaks in — the three-call TS/PY/TS sequence below is
    // built to catch exactly that leak. It does NOT, on its own, pin that the
    // fold must be re-DERIVED rather than read from a cache that happens to
    // already be warm for THIS SAME repository going cold-to-warm across two
    // runs of the identical grammar set — a cache-reading fold passes this
    // sequence too, since nothing here calls the SAME repository twice with a
    // COLD cache in between. That cold-callability guarantee is pinned
    // instead by `cli-roots-basic.test.ts`'s D13 no-op short-circuit e2e
    // case: a cache-reading `bindingHash` would still be correct on a warm
    // process but would report `undefined`/collapse to a constant for a
    // bindingHash computed before mining ever runs (D13 needs it BEFORE the
    // walk that would warm the cache), breaking "already current" for a cold
    // CLI invocation. Do not delete that e2e case believing this unit test
    // alone covers the fold's cold-callability.
    const index = (files: Record<string, string>) =>
      withTmpRepo(files, async (dir) => (await runRootsIndex(dir, config, [])).bindingSetHash);

    // 1. TypeScript-only repo, cache cold for this file's worker process.
    const tsCold = await index(TS_ONLY);
    // 2. Python-only repo — warms the cache with a grammar the next run must NOT fold.
    const py = await index(PY_ONLY);
    // 3. The SAME TypeScript-only repo again, cache now carrying python too.
    const tsWarm = await index(TS_ONLY);

    // Different grammar sets fold to different hashes (kills a constant fold).
    expect(py).not.toBe(tsCold);
    // Cache warmth is invisible: the fold is per-run, not per-process (kills
    // the cache fold — under it, tsWarm would also cover python and diverge).
    expect(tsWarm).toBe(tsCold);
  });

  it('computeUsedGrammarSetHash dedupes multiple files of the SAME grammar onto one entry — the hash matches a single-file repo of that grammar', async () => {
    const config = await defaultRootsConfig();
    const oneFile = await withTmpRepo(TS_ONLY, (dir) => computeUsedGrammarSetHash(dir, config));
    const twoFiles = await withTmpRepo(
      { 'src/a.ts': 'function g() { return 1; }\n', 'src/b.ts': 'function h() { return 2; }\n' },
      (dir) => computeUsedGrammarSetHash(dir, config),
    );
    // Two typescript files fold to the SAME hash as one — the asset is keyed
    // by grammar, not by file count, so the dedup ("already have this
    // asset's hash") branch is what makes a repo with N files of one grammar
    // hash identically to a repo with 1.
    expect(twoFiles).toBe(oneFile);
  });
});
