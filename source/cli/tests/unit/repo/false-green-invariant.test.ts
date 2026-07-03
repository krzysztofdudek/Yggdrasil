// =============================================================================
// GUARD 2 — false-green invariant over the DOGFOOD graph.
//
// The bug class fixed in the cleanup: a mapped source file silently leaves the
// review set, so an enforced rule passes VACUOUSLY over code no reviewer ever
// saw (a "false green"). This guard re-asserts the invariant directly on this
// repo's own `.yggdrasil/` graph, loaded and computed exactly as `yg check`
// does (loadGraph + computeExpectedPairs + the coverage-scan helpers).
//
// INVARIANT
//   Every file that the coverage scan counts as COVERED (git-tracked, not under
//   a nested-graph subtree, not under the bound `.yggdrasil/`, and matched by a
//   node mapping) and is readable is EITHER:
//     (A) present in at least one expected verification pair's subject set, OR
//     (B) legitimately accounted for — exactly one of:
//         (B1) NO RULE APPLIES: none of its owning nodes carry any effective
//              non-draft, non-aggregate aspect that would take it as a subject.
//              (Organizational / config / doc nodes that map files but attach no
//              enforceable reviewer produce zero pairs by design — there is no
//              rule to pass vacuously, so this is not a false green.)
//         (B2) BINARY + LLM-ONLY: for every effective non-draft, non-aggregate
//              aspect on it, the aspect is an LLM reviewer and the file is binary
//              (binaries are excluded from LLM subject sets by design).
//         (B3) SCOPE-EXCLUDED: every effective non-draft, non-aggregate aspect
//              that would otherwise take it has a `scope.files` filter the file
//              fails (a deliberate author choice).
//   A covered, readable, git-tracked file that is in NO pair and for which some
//   owning node has an effective enforced/advisory aspect that SHOULD take it as
//   a subject (not binary-excluded, not scope-excluded) is a SILENT FALSE GREEN —
//   the test FAILS and names the file with the offending (node :: aspect).
//
// This is the GENERAL invariant form (not the focused fallback). It held cleanly
// on the cleaned repo with zero special-casing of individual files: the legitimate
// exclusions above are derived structurally from the graph, never hard-coded.
//
// It ALSO asserts the unreadable channel is empty: `computeExpectedPairs` returns
// `unreadable[]` for any mapped subject file the content filter or the readability
// probe could not read (the silent-drop the cleanup closed). On a clean dogfood
// graph that array must be empty; a non-empty entry is itself a false-green signal
// and fails here with the same naming.
//
// Hermetic: pure in-process computation over the committed graph + `git ls-files`.
// No spawned binary, no network, no clock/random. Deterministic.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { computeExpectedPairs } from '../../../src/core/pairs.js';
import { scanUncoveredFiles } from '../../../src/core/check.js';
import { excludeNestedGraphSubtrees } from '../../../src/io/repo-scanner.js';
import { toPosixPath } from '../../../src/utils/posix.js';
import {
  computeEffectiveAspects,
  computeEffectiveAspectStatuses,
  isAggregateAspect,
} from '../../../src/core/graph/aspects.js';
import { normalizeMappingPaths } from '../../../src/io/paths.js';
import { mappingEntryMatchesFile } from '../../../src/utils/mapping-path.js';
import { BINARY_EXTENSIONS } from '../../../src/utils/binary-extensions.js';
import { evaluateFileWhen } from '../../../src/core/file-when-evaluator.js';
import { FileContentCache } from '../../../src/io/file-content-cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/unit/repo → repo root is five levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const DOGFOOD_GRAPH = path.join(REPO_ROOT, '.yggdrasil');

/** git-tracked files relative to the repo root (the same set `yg check` scans). */
function gitTrackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '.'], { cwd: REPO_ROOT, encoding: 'utf-8' });
  return out.trim().split('\n').filter((f) => f.length > 0);
}

/**
 * The set of files the coverage scan counts as COVERED, computed exactly as
 * core/check.ts does: take git-tracked files, drop nested-graph subtrees and the
 * bound `.yggdrasil/`, then subtract the uncovered set that `scanUncoveredFiles`
 * reports. What remains is "covered".
 */
function computeCoveredFiles(
  graph: Awaited<ReturnType<typeof loadGraph>>,
  tracked: string[],
): string[] {
  const projectRoot = path.dirname(graph.rootPath);
  const yggPrefix = toPosixPath(path.relative(projectRoot, graph.rootPath));
  const sourceFiles = excludeNestedGraphSubtrees(tracked)
    .map((f) => toPosixPath(f.trim()))
    .filter((f) => !f.startsWith(yggPrefix + '/') && f !== yggPrefix);
  const uncovered = new Set(scanUncoveredFiles(graph, tracked));
  return sourceFiles.filter((f) => !uncovered.has(f));
}

describe('GUARD: dogfood false-green invariant — no readable mapped file silently unreviewed', () => {
  it.skipIf(!existsSync(DOGFOOD_GRAPH))(
    'every covered, readable, git-tracked file is in a pair OR legitimately accounted for',
    async () => {
      const graph = await loadGraph(REPO_ROOT);
      const projectRoot = path.dirname(graph.rootPath);
      const { pairs, unreadable } = await computeExpectedPairs(graph);

      // ── Assertion 0: the unreadable channel is empty ──────────────────────
      // A non-empty `unreadable[]` IS a silent-drop signal: a mapped subject file
      // the content filter or readability probe could not read, dropped from the
      // review surface. On a clean dogfood graph this must be empty.
      expect(
        unreadable,
        unreadable.length === 0
          ? ''
          : `computeExpectedPairs reported ${unreadable.length} unreadable subject file(s) — each is a mapped file dropped from review (a potential false green):\n` +
              unreadable.map((u) => `  ${u.path}  [${u.nodePath} :: ${u.aspectId}]  ${u.reason}`).join('\n'),
      ).toEqual([]);

      // Union of every file that the reviewer would actually see.
      const inPair = new Set<string>();
      for (const p of pairs) for (const f of p.subjectFiles) inPair.add(f);

      const tracked = gitTrackedFiles();
      const covered = computeCoveredFiles(graph, tracked);

      const cache = new FileContentCache();
      const offenders: string[] = [];

      for (const file of covered) {
        if (inPair.has(file)) continue; // (A) — seen by a reviewer.

        const ext = path.extname(file).toLowerCase();
        const isBinary = BINARY_EXTENSIONS.has(ext);

        // Build the set of "expectations" this file has: every (owning node,
        // effective non-draft non-aggregate aspect) that would take it as a
        // subject if no legitimate exclusion applied. If that set is empty, no
        // rule applies (B1) and the file is fine. Each remaining expectation
        // must be explained by a binary (B2) or scope (B3) exclusion.
        const unexplained: string[] = [];

        for (const [nodePath, node] of graph.nodes) {
          const maps = normalizeMappingPaths(node.meta.mapping);
          if (!maps.some((m) => mappingEntryMatchesFile(m, file))) continue;

          let effective: Set<string>;
          let statuses: Map<string, string>;
          try {
            effective = computeEffectiveAspects(node, graph);
            statuses = computeEffectiveAspectStatuses(node, graph) as Map<string, string>;
          } catch {
            // A node whose effectiveness throws (e.g. an implies cycle) contributes
            // no pairs and is surfaced separately by the validator — skip it here.
            continue;
          }

          for (const aspectId of effective) {
            if (isAggregateAspect(graph, aspectId)) continue; // (no own reviewer)
            const status = statuses.get(aspectId) ?? 'enforced';
            if (status === 'draft') continue; // draft → not in the expected set.

            const def = graph.aspects.find((a) => a.id === aspectId);
            if (!def) continue;
            const kind = def.reviewer.type; // 'llm' | 'deterministic'

            // (B2) BINARY + LLM: binaries are excluded from LLM subject sets.
            if (kind === 'llm' && isBinary) continue;

            // (B3) SCOPE-EXCLUDED: a scope.files filter the file fails.
            if (def.scope?.files) {
              const r = await evaluateFileWhen(def.scope.files, {
                absPath: path.resolve(projectRoot, file),
                repoRelPath: file,
                projectRoot,
                cache,
              });
              // An unreadable result here would already be in `unreadable[]`
              // (asserted empty above); a clean `false` is a deliberate exclusion.
              if (!r.result) continue;
            }

            // No legitimate exclusion — this file SHOULD have produced a pair
            // containing it under (aspectId, node), but it did not.
            unexplained.push(`${nodePath} :: ${aspectId} [${status}/${kind}]`);
          }
        }

        if (unexplained.length > 0) {
          offenders.push(`  ${file}  -> ${unexplained.join(', ')}`);
        }
      }

      expect(
        offenders,
        offenders.length === 0
          ? ''
          : `Found ${offenders.length} covered, readable, git-tracked file(s) that are in NO verification pair and are NOT legitimately excluded — a SILENT FALSE GREEN: an enforced/advisory rule applies to the file's node but no reviewer ever sees the file.\n` +
              `Each line shows the file and the (node :: aspect) expectation that was silently dropped. Fix the mapping/scope so the file enters review, or (if the drop is intentional) make the exclusion explicit.\n` +
              offenders.join('\n'),
      ).toEqual([]);
    },
    // Integration-scale guard: a full loadGraph + computeExpectedPairs over the
    // whole repo graph (300+ nodes, 1000+ files) plus a per-file scan. It is fast
    // in isolation but legitimately exceeds the 5s default under full-suite CPU
    // contention — give it headroom so a saturated run does not flake the gate.
    60_000,
  );

  it.skipIf(!existsSync(DOGFOOD_GRAPH))(
    'the dogfood graph yields a non-trivial covered set and pair set (guard is wired up)',
    async () => {
      // Defends against a silent no-op: if loadGraph / the coverage scan returned
      // nothing, the invariant above would pass vacuously over zero files.
      const graph = await loadGraph(REPO_ROOT);
      const { pairs } = await computeExpectedPairs(graph);
      const covered = computeCoveredFiles(graph, gitTrackedFiles());
      expect(graph.nodes.size).toBeGreaterThan(50);
      expect(covered.length).toBeGreaterThan(100);
      expect(pairs.length).toBeGreaterThan(50);
    },
    60_000,
  );
});
