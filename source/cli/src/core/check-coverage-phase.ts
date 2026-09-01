/**
 * source/cli/src/core/check-coverage-phase.ts — the coverage section of a check:
 * how much of the repository the graph actually governs, and what is said about
 * the part it does not.
 *
 * Composes three layers over one file list, most-binding first:
 *   - the node mappings (which files an explicit component already owns),
 *   - the coverage tiers (which of the rest are errors, warnings, or silently
 *     excluded),
 *   - the type-level classification lattice, when opted in (which of the rest a
 *     single architecture type quietly answers for, which two types fight over,
 *     and which could not be read at all).
 *
 * One issue per file, most-binding wins: a file already spoken for by the
 * lattice never also appears in the bulk unmapped listing or its count. With the
 * lattice off — the default — the block that applies it never runs and the
 * output is byte-identical to a graph that has no type-level coverage at all.
 *
 * Two facts are computed regardless of whether a file walk was available, so a
 * report can still say whether type-level coverage was on and whether the
 * architecture declares any type capable of matching a file.
 *
 * The tracked-but-gitignored anomaly is deliberately NOT part of this phase: it
 * is the one check fed by injected git output rather than the disk walk, and
 * every injected input is gated at the orchestrator so an absent one visibly
 * skips exactly one check.
 */

import path from 'node:path';

import type { Graph, CoverageConfig } from '../model/graph.js';
import type { TypeCoverageResult } from './type-coverage.js';
import { toPosixPath } from '../utils/posix.js';
import { fileUnit } from '../model/lock.js';
import { excludeNestedGraphSubtrees } from '../io/repo-scanner.js';
import {
  partitionByCoverageTier,
  buildCoverageIssue,
  buildCoverageAdvisoryIssue,
  checkRequiredShadowedByExcluded,
} from './check-coverage-tiers.js';
import { scanUncoveredFiles } from './check-coverage-scan.js';
import type { CheckIssue } from './check-contract.js';

/**
 * Type-level coverage (coverage.type_level) enrichment: a file matching no
 * classifying type has no type-specific fix — the plain "add it to a node
 * mapping" advice is all there is, now said explicitly, with a `yg
 * type-suggest` pointer in NEXT (actionable, not folded into WHY).
 *
 * Callers MUST call this only when every listed file actually ran through the
 * lattice and came back `unmatched`. The excluded-ancestor-of-required corner
 * that once needed a separate check is now impossible (exclusion is absolute,
 * so a file can never be muted from classification yet still land in a
 * coverage tier). A muted file was never checked against any type; claiming
 * "your architecture has no type for this file" would be unestablished.
 * Returns `issue` unchanged when null.
 */
function enrichNoTypeMessage(issue: CheckIssue | null): CheckIssue | null {
  if (issue === null) return issue;
  // Appended to the FIRST line of `next`, not a new trailing line: the
  // renderer for this issue shape (renderUnmappedBlock, cli/check.ts) shows
  // only next.split('\n')[0] — a later line would never reach the terminal.
  const nextLines = issue.messageData.next.split('\n');
  nextLines[0] =
    `${nextLines[0]} yg type-suggest --file <path> can help design one before you decide where it belongs.`;
  return {
    ...issue,
    messageData: {
      ...issue.messageData,
      why: `${issue.messageData.why} Your architecture has no type for this file yet.`,
      next: nextLines.join('\n'),
    },
  };
}

/** What the coverage section contributes to the report the orchestrator assembles. */
export interface CoveragePhaseResult {
  issues: CheckIssue[];
  coveredFiles: number;
  totalFiles: number;
  typeCoveredCount: number;
  nodeOwnedFiles: number;
  excludedFiles: number;
  typeLevel: boolean;
  classifyingTypeCount: number;
}

export async function runCoveragePhase(args: {
  graph: Graph;
  projectRoot: string;
  /** The coverage-visible file list. Null skips the scan; the two config/architecture facts are still reported. */
  coverageVisibleFiles: string[] | null;
  /** Resolved once by the orchestrator, ahead of the relation pass, and passed in. */
  coverage: CoverageConfig;
  /** The type-level lattice the orchestrator already classified. Undefined at flag-off. */
  earlyTypeCoverage: TypeCoverageResult | undefined;
}): Promise<CoveragePhaseResult> {
  const { graph, projectRoot, coverageVisibleFiles, coverage, earlyTypeCoverage } = args;

  let coveredFiles = 0;
  let totalFiles = 0;
  let typeCoveredCount = 0;
  let nodeOwnedFiles = 0;
  let excludedFiles = 0;
  // `coverage` is resolved by the orchestrator before lock verification / the
  // relation pass and handed in — see its declaration there and
  // earlyTypeCoverage's own comment for why.
  // Pure config check — fires on EVERY run regardless of walk availability
  // or the type-level flag. Seeds coverageIssues (rather than an empty-array
  // declaration pushed into later): the coverageVisibleFiles branch below
  // reassigns coverageIssues wholesale, so a later push here would be
  // silently discarded.
  let coverageIssues: CheckIssue[] = checkRequiredShadowedByExcluded(coverage);
  const typeLevel = coverage.typeLevel === true;
  // Pure architecture fact — independent of the flag and of file-walk
  // availability — so the zero-classifying-types notice can fire even when
  // coverageVisibleFiles is null (no coverage scan ran this call). classifyFile
  // skips every type without `when` (core/type-classifier.ts), so this count
  // staying 0 with the flag on means the lattice can never match a file.
  const classifyingTypeCount = Object.values(graph.architecture.node_types).filter(
    (t) => t.when !== undefined,
  ).length;
  if (coverageVisibleFiles !== null) {
    const yggPrefix = toPosixPath(path.relative(projectRoot, graph.rootPath));
    const sourceFiles = excludeNestedGraphSubtrees(coverageVisibleFiles).filter(f => {
      const normalized = toPosixPath(f.trim());
      return !normalized.startsWith(yggPrefix + '/') && normalized !== yggPrefix;
    });
    totalFiles = sourceFiles.length;
    const uncovered = scanUncoveredFiles(graph, coverageVisibleFiles);
    const tiers = partitionByCoverageTier(uncovered, coverage);
    // coveredFiles/totalFiles keep their pre-existing conflated meaning
    // (node-mapped OR excluded, both counted "covered") — the flag-off
    // header and portal/extract.ts's meta.counts both read this unchanged.
    coveredFiles = totalFiles - (tiers.required.length + tiers.middle.length);
    // nodeOwnedFiles/excludedFiles split that same total honestly: a file is
    // node-owned only if an actual node mapping covers it (not in `uncovered`
    // at all); an excluded-root file is neither required nor middle tier but
    // IS in `uncovered` — partitionByCoverageTier drops it silently, so it is
    // recovered here by subtraction. nodeOwnedFiles + excludedFiles ===
    // coveredFiles always.
    nodeOwnedFiles = totalFiles - uncovered.length;
    excludedFiles = uncovered.length - (tiers.required.length + tiers.middle.length);

    // Type-level classification lattice: OFF (the default) ⇒ this block never
    // runs and requiredForIssue/middleForIssue stay the untouched tiers with no
    // extra issue added — byte-identical to pre-type-level output.
    let requiredForIssue = tiers.required;
    let middleForIssue = tiers.middle;
    const typeLevelIssues: CheckIssue[] = [];
    let sawTypeLevel = false;
    if (coverage.typeLevel && earlyTypeCoverage) {
      sawTypeLevel = true;
      // Reuse the SAME lattice result computed earlier (before the relation pass) —
      // no second full classification pass over every uncovered file.
      const typeCoverage = earlyTypeCoverage;
      typeCoveredCount = typeCoverage.covered.size;

      // The lattice is one issue per file, most-binding wins: covered/
      // ambiguous/strict-claimed/unreadable files each already have their own
      // (silent, or more specific) verdict, so ALL four are dropped from the
      // bulk unmapped/advisory listing and from its uncoveredCount — only
      // genuinely-unmatched files remain in it. strictClaimed's own file is
      // still the strict backward scan's business (type-strict-orphan /
      // type-strict-misplaced), unaffected by this filter.
      const spokenFor = new Set<string>(typeCoverage.covered.keys());
      for (const a of typeCoverage.ambiguous) spokenFor.add(a.file);
      for (const s of typeCoverage.strictClaimed) spokenFor.add(s.file);
      for (const u of typeCoverage.unreadable) spokenFor.add(u.file);
      requiredForIssue = tiers.required.filter((f) => !spokenFor.has(f));
      middleForIssue = tiers.middle.filter((f) => !spokenFor.has(f));

      for (const a of typeCoverage.ambiguous) {
        typeLevelIssues.push({
          severity: 'error',
          code: 'ambiguous-node-type',
          rule: 'ambiguous-node-type',
          messageData: {
            what: `File '${toPosixPath(a.file)}' matches ${a.typeIds.length} classifying types: ${a.typeIds.join(', ')}.`,
            why: `Type-level coverage applies exactly one type's rules per file. Two matching types is a situation the machine refuses to guess — each type carries different rules.`,
            next: `Two exits:\n  1. Create an explicit node declaring the intended type (yg-node.yaml with type: <one of: ${a.typeIds.join(' | ')}>) — its pairs re-key under the owner.\n  2. Narrow one of the overlapping when: predicates in yg-architecture.yaml so exactly one matches — existing verdicts revalidate free.\nEither exit may surface new type-relation-forbidden findings for this file's own imports, now that they join the live gate.`,
          },
          unitKey: fileUnit(toPosixPath(a.file)),
        });
      }

      // One issue PER FILE, not per (file, type) pair. "too-large" is not an
      // OS error, so its NEXT offers real exits instead of a permissions fix.
      const unreadableWhy =
        'coverage.type_level requires reading file content to classify an uncovered file — it must not be silently treated as covered, ambiguous, or unmatched.';
      for (const u of typeCoverage.unreadable) {
        const n = u.typeIds.length;
        const typeWord = n === 1 ? 'classifying type' : 'classifying types';
        const typeList = u.typeIds.join(', ');
        if (u.kind === 'too-large') {
          typeLevelIssues.push({
            severity: 'error',
            code: 'file-unreadable',
            rule: 'file-unreadable',
            messageData: {
              what: `Type-level coverage could not classify '${toPosixPath(u.file)}' against ${n} ${typeWord} (${typeList}) — the file exceeds the content-scan size limit.`,
              why: unreadableWhy,
              next: `Either gitignore the file, add its root to coverage.excluded, or drop the content: atom from ${n === 1 ? 'the type above' : 'the types above'}.`,
            },
          });
        } else {
          typeLevelIssues.push({
            severity: 'error',
            code: 'file-unreadable',
            rule: 'file-unreadable',
            messageData: {
              what: `Type-level coverage could not read '${toPosixPath(u.file)}' while classifying it against ${n} ${typeWord} (${typeList}).\nOS error: ${u.reason}`,
              why: unreadableWhy,
              next: `Fix file permissions, or add to .gitignore if it's a generated artifact.`,
            },
          });
        }
      }
    }

    let requiredIssue = buildCoverageIssue(requiredForIssue, totalFiles);
    let middleIssue = buildCoverageAdvisoryIssue(middleForIssue);
    if (sawTypeLevel) {
      // Every file left in requiredForIssue/middleForIssue after the
      // spokenFor filter is, by construction, one computeTypeCoverage
      // evaluated and found no type for — the corner that once needed a
      // separate genuinely-unmatched guard is now impossible, since
      // isExcludedByCoverage is the one authority both this tiering and the
      // lattice's own mute go through.
      requiredIssue = enrichNoTypeMessage(requiredIssue);
      middleIssue = enrichNoTypeMessage(middleIssue);
    }
    coverageIssues = [...coverageIssues, requiredIssue, middleIssue, ...typeLevelIssues].filter(
      (x): x is CheckIssue => x !== null,
    );
  }

  return {
    issues: coverageIssues,
    coveredFiles,
    totalFiles,
    typeCoveredCount,
    nodeOwnedFiles,
    excludedFiles,
    typeLevel,
    classifyingTypeCount,
  };
}
