import path from 'node:path';
import type { Graph } from '../../model/graph.js';
import type { ValidationIssue } from '../../model/validation.js';
import { fileUnit } from '../../model/lock.js';
import { normalizeMappingPaths } from '../../io/paths.js';
import { expandMappingPaths, expandMappingPathsWithinOwnGraph } from '../../io/hash.js';
import { mappingEntryMatchesFile, isGlobPattern, normalizeMappingPath } from '../../utils/mapping-path.js';
import { buildOwnerIndex } from '../../relations/owner-index.js';
import { readSortedDir, statPath } from '../../io/graph-fs.js';
import { walkRepoFiles, isCoverageExcludedPath, findNestedProjectRoots, NO_COVERAGE_EXCLUDED, resolveGraphExclusionSet, filterExcludedFromGraph, describeExclusionSource, type GraphExclusionSet } from '../../io/repo-scanner.js';
import { FileContentCache } from '../../io/file-content-cache.js';
import { evaluateFileWhen } from '../file-when-evaluator.js';
import { classifyFile } from '../type-classifier.js';
import { renderTrace } from '../../formatters/predicate-trace.js';
import { issueMsg } from './shared.js';
import { toPosixPath } from '../../utils/posix.js';

export async function checkFileMappingGitignored(graph: Graph): Promise<ValidationIssue[]> {
  const projectRoot = path.dirname(graph.rootPath);
  const coverage = graph.config.coverage ?? NO_COVERAGE_EXCLUDED;
  const [walkedFiles, nestedProjectRoots] = await Promise.all([
    walkRepoFiles(projectRoot).then((files) => new Set(files)),
    findNestedProjectRoots(projectRoot),
  ]);
  const exclusion: GraphExclusionSet = { nestedRoots: nestedProjectRoots, coverage };
  const issues: ValidationIssue[] = [];

  for (const [nodePath, node] of graph.nodes) {
    const mapping = node.meta.mapping ?? [];
    for (const relPath of mapping) {
      // Paths that walkRepoFiles skips for STRUCTURAL reasons (the top-level
      // `.yggdrasil/` graph directory, any `.git` segment) are absent from
      // `walkedFiles` but are NOT gitignored. Mapping a committed rule file under
      // `.yggdrasil/` is sanctioned meta-modeling; treating its structural
      // absence as ".gitignored" would block the very mapping the docs instruct
      // authors to write. Exempt exactly those paths here.
      if (isCoverageExcludedPath(relPath)) continue;
      // Normalize the mapping entry (strip a leading './', convert separators)
      // before the walked-set membership test. `walkedFiles` holds clean POSIX
      // repo-relative paths, but a mapping entry like './src/a.ts' arrives here
      // only trimmed — an unnormalized comparison would miss the walked file
      // and falsely report a present, non-gitignored file as gitignored.
      const norm = normalizeMappingPath(relPath);
      const absPath = path.join(projectRoot, norm);
      let st;
      try { st = await statPath(absPath); } catch { continue; }
      if (!st.isFile()) continue;

      // Exclusion is checked BEFORE the walked-file short-circuit below, and
      // regardless of it: an excluded path is gone from this graph whether or
      // not the disk walk would otherwise surface it, so a walked-but-excluded
      // file must still be reported as excluded, not silently passed over
      // because `walkedFiles.has(norm)` would otherwise short-circuit this
      // loop. A file absent from `walkedFiles` for this reason (nested-project
      // boundary) was never gitignored at all — blaming .gitignore would send
      // an adopter to edit a file that may not exist and hides the real cause,
      // which is why this generalized check runs first, one level ABOVE the
      // more specific gitignore diagnosis below.
      const exclusionSource = describeExclusionSource(norm, exclusion);
      if (exclusionSource !== null) {
        // Names WHICH of the two independent sources caused this, instead of
        // making the adopter check both their own config and the filesystem
        // to find out: a nested project's own boundary is never something a
        // `coverage.excluded` edit can fix, and vice versa.
        const cause = exclusionSource === 'nested-project'
          ? `it sits inside a separate project's own boundary (a nested \`.yggdrasil/\` graph, or its own \`.git\` — a checkout, submodule, or worktree)`
          : `it matches a \`coverage.excluded\` root in yg-config.yaml`;
        const undoExclusion = exclusionSource === 'nested-project'
          ? `move the file outside the separate project's own boundary`
          : `remove the matching \`coverage.excluded\` entry`;
        issues.push({
          severity: 'error',
          code: 'file-mapping-excluded',
          rule: 'file-mapping-excluded',
          nodePath,
          ...issueMsg({
            what: `File '${toPosixPath(norm)}' is in mapping of node '${nodePath}' but is excluded from graph coverage.`,
            why: `An exclusion cuts everything it matches, including a node's own explicit mapping entry — this file is never enforced while excluded, no matter how deliberately the mapping names it. It is excluded because ${cause}.`,
            next: `Either:\n  1. Remove the file from the mapping (it is never enforced while excluded).\n  2. If it should be enforced, ${undoExclusion}.`,
          }),
        });
        continue;
      }

      if (walkedFiles.has(norm)) continue;

      issues.push({
        severity: 'error',
        code: 'file-mapping-gitignored',
        rule: 'file-mapping-gitignored',
        nodePath,
        ...issueMsg({
          what: `File '${toPosixPath(norm)}' is in mapping of node '${nodePath}' but is excluded by .gitignore.`,
          why: `Mappings cannot contain .gitignored files — strict backward scan skips them, creating a gap where agent-created files matching a strict type's when could evade enforcement.`,
          next: `Either:\n  1. Remove the file from .gitignore (if it should be tracked code).\n  2. Remove the file from the mapping (if it's a generated artifact).`,
        }),
      });
    }
  }
  return issues;
}
export function checkFileDuplicateMapping(_graph: Graph): ValidationIssue[] { return []; }
export async function checkStrictBackwardCoverage(
  graph: Graph,
  cache: FileContentCache,
): Promise<{ issues: ValidationIssue[]; unreadable: ValidationIssue[] }> {
  const strictTypes = Object.entries(graph.architecture.node_types).filter(
    ([, def]) => def.enforce === 'strict' && def.when !== undefined,
  );
  if (strictTypes.length === 0) return { issues: [], unreadable: [] };

  const projectRoot = path.dirname(graph.rootPath);

  // An excluded file (a nested project's own boundary, or a coverage.excluded
  // root an adopter configured) is gone from this graph's enforcement surface
  // the same way it is gone everywhere else that decides file ownership — the
  // strict backward scan is no exception. Filtered here, once, before `when`
  // is ever evaluated: such a file can be neither an orphan nor misplaced,
  // because it was never a candidate this graph considers in the first place.
  const exclusion = await resolveGraphExclusionSet(projectRoot, graph.config.coverage ?? NO_COVERAGE_EXCLUDED);
  const repoFiles = filterExcludedFromGraph(await walkRepoFiles(projectRoot), exclusion);
  const issues: ValidationIssue[] = [];
  const unreadable: ValidationIssue[] = [];
  // Keyed by sorted type-pair, holding the ISSUE OBJECT already pushed into
  // `issues` for that pair (not just a seen-flag): a later file matching the
  // same pair must not push a second issue (dedup, unchanged), but its file
  // must still be recorded on the first issue's `relationEdges` — the
  // structured field has to carry every matching file, not only the one the
  // message samples. Mutating the already-pushed object in place (rather than
  // deferring the push) keeps `issues`' push order/count/timing byte-identical
  // to before this field existed.
  const overlapIssueByPair = new Map<string, ValidationIssue>();

  // File→owner resolution must agree with the runtime child-precedence rule
  // (getChildMappingExclusions and the live relation-conformance owner index):
  // a descendant node that claims a file inside a parent's glob owns it. Build
  // the canonical owner index ONCE (it scans every node's mappings and is
  // file-independent) rather than picking the first matching node in graph
  // insertion order, which always resolved the ancestor and disagreed with the
  // real owner used to attach aspects.
  const ownerIndex = buildOwnerIndex(graph.nodes);

  for (const rawRel of repoFiles) {
    // walkRepoFiles already POSIX-normalizes, but re-apply the canonical normalization
    // defensively so every repo-relative path written into an output message below is
    // provably POSIX (no backslash, no trailing slash) regardless of the scanner's
    // contract. Idempotent on already-clean paths, so file-owner lookups are unaffected.
    const relPath = normalizePathForCompare(rawRel);
    const absPath = path.join(projectRoot, relPath);

    // Evaluate each strict type's when against this file.
    const matchingTypes: Array<{ typeId: string; trace: string }> = [];
    let fileSkipped = false;

    for (const [typeId, def] of strictTypes) {
      const result = await evaluateFileWhen(def.when!, {
        absPath,
        repoRelPath: relPath,
        projectRoot,
        cache,
      });

      if (result.unreadable) {
        unreadable.push({
          severity: 'error',
          code: 'file-unreadable',
          rule: 'file-unreadable',
          ...issueMsg({
            what: `Validator could not read '${relPath}' during strict backward scan.\nOS error: ${result.unreadableReason ?? 'unknown'}`,
            why: `Strict enforcement of type '${typeId}' requires reading file content. Files that cannot be opened cannot be classified.`,
            next: `Fix file permissions, or add to .gitignore if it's a generated artifact.`,
          }),
        });
        fileSkipped = true;
        break;
      }

      if (result.result) matchingTypes.push({ typeId, trace: renderTrace(result.trace, '  ') });
    }

    if (fileSkipped) continue;

    if (matchingTypes.length > 1) {
      // Two or more strict types claim this file — conflicting architecture.
      const sorted = matchingTypes.map((m) => m.typeId).sort();
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const key = `${sorted[i]}|${sorted[j]}`;
          const existing = overlapIssueByPair.get(key);
          if (existing) {
            // Same pair, a later file: message stays the first file's example
            // (sampling is a display concern), but the edge list must be
            // complete. No real from/to relationship exists here — one file,
            // not a pair, is the subject — so each entry is a self-referencing
            // {fromFile, toFile}, reusing type-relation-forbidden's aggregate
            // edge-list shape rather than adding a second field for it.
            existing.relationEdges!.push({ fromFile: relPath, toFile: relPath });
            continue;
          }
          const issue: ValidationIssue = {
            severity: 'error',
            code: 'strict-overlap-conflict',
            rule: 'strict-overlap-conflict',
            ...issueMsg({
              what: `Two types with enforce: strict have overlapping when predicates:\n  '${sorted[i]}'.when matches\n  '${sorted[j]}'.when matches\nExample matching file: '${relPath}'`,
              why: `Both types declare enforce: strict — each demands that any matching file be owned by a node of its type. With the one-owner rule, satisfying both simultaneously is impossible.`,
              next: `Narrow one of the when predicates so they cannot both match the same file.\nRun: yg impact --type ${sorted[i]}\nRun: yg impact --type ${sorted[j]}`,
            }),
            relationEdges: [{ fromFile: relPath, toFile: relPath }],
          };
          overlapIssueByPair.set(key, issue);
          issues.push(issue);
        }
      }
      continue; // Conflict supersedes orphan/misplaced for this file.
    }

    if (matchingTypes.length === 0) continue;

    const { typeId, trace } = matchingTypes[0];
    // Glob-aware owner resolution via the canonical child-precedence resolver, so
    // a descendant node that claims this file inside a parent's glob is picked as
    // the owner (matching the runtime subject-set), not the ancestor.
    const ownerPath = ownerIndex.ownerOf(relPath);
    const owner: { nodePath: string; nodeType: string } | undefined =
      ownerPath !== undefined
        ? { nodePath: ownerPath, nodeType: graph.nodes.get(ownerPath)!.meta.type }
        : undefined;
    if (owner === undefined) {
      // Type-level coverage enrichment (flag-gated): the strict scan already
      // owns this file (no ambiguous-node-type is ever raised for it — see
      // core/type-coverage.ts), but naming any OTHER type it also matches is
      // exactly the extra fact an agent needs when deciding which type this
      // file should actually become. classifyFile is re-run for this one file
      // only (matchingTypes already proves no other STRICT type matches, or
      // this file would have hit the overlap-conflict branch above instead).
      // Deliberately NOT given a TypeClassCache: this only fires per
      // type-strict-orphan file (an unresolved-architecture-error state, not
      // the steady-state path every run pays), and the classification it
      // produces feeds a message annotation ("Also matches: ..."), never a
      // coverage verdict — there is no per-run cost here worth caching
      // against, unlike the whole-uncovered-file-tree scans computeTypeCoverage
      // wires by default.
      let what = `File '${relPath}' satisfies when of type '${typeId}' (enforce: strict):\n${trace}\nBut file is not in any node's mapping.`;
      if (graph.config.coverage?.typeLevel) {
        const classification = await classifyFile(absPath, relPath, graph, cache);
        const alsoMatches = classification.matches
          .filter((m) => graph.architecture.node_types[m.typeId]?.enforce !== 'strict')
          .map((m) => m.typeId);
        if (alsoMatches.length > 0) {
          what += `\nAlso matches: ${alsoMatches.join(', ')}`;
        }
      }
      issues.push({
        severity: 'error',
        code: 'type-strict-orphan',
        rule: 'type-strict-orphan',
        ...issueMsg({
          what,
          why: `Type '${typeId}' has enforce: strict — every file satisfying its when must belong to a mapping of a node of type '${typeId}'. Otherwise the file looks like a ${typeId} but bypasses ${typeId}-level enforcement.`,
          next: `Create yg-node.yaml with type: ${typeId} and add '${relPath}' to its mapping.`,
        }),
        unitKey: fileUnit(relPath),
      });
    } else if (owner.nodeType !== typeId) {
      issues.push({
        severity: 'error',
        code: 'type-strict-misplaced',
        rule: 'type-strict-misplaced',
        nodePath: owner.nodePath,
        ...issueMsg({
          what: `File '${relPath}' satisfies when of type '${typeId}' (enforce: strict):\n${trace}\nBut is in mapping of node '${owner.nodePath}' (type: ${owner.nodeType}).`,
          why: `Type '${typeId}' has enforce: strict — every file satisfying its when must be owned by a node of type '${typeId}'. Current owner has wrong type.`,
          next: `Options:\n  1. Move mapping entry to a ${typeId}-type node.\n  2. Refactor file so it no longer matches ${typeId}.when.\n  3. Change '${owner.nodePath}' type to '${typeId}' if conceptually correct.`,
        }),
      });
    }
  }
  return { issues, unreadable };
}

// --- Rule 5: Mapping ownership overlap ---

function normalizePathForCompare(mappingPath: string): string {
  return toPosixPath(mappingPath.trim());
}

function arePathsOverlapping(pathA: string, pathB: string): boolean {
  if (pathA === pathB) return true;
  return pathA.startsWith(pathB + '/') || pathB.startsWith(pathA + '/');
}

function isAncestorNode(possibleAncestor: string, possibleDescendant: string): boolean {
  return possibleDescendant.startsWith(possibleAncestor + '/');
}

export async function checkMappingOverlap(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const ownership: Array<{ nodePath: string; mappingPath: string }> = [];

  for (const [nodePath, node] of graph.nodes) {
    const mappingPaths = normalizeMappingPaths(node.meta.mapping)
      .map(normalizePathForCompare)
      .filter((mappingPath) => mappingPath.length > 0);
    for (const mappingPath of mappingPaths) {
      ownership.push({ nodePath, mappingPath });
    }
  }

  for (let index = 0; index < ownership.length; index++) {
    const current = ownership[index];
    for (let nestedIndex = index + 1; nestedIndex < ownership.length; nestedIndex++) {
      const candidate = ownership[nestedIndex];
      if (current.nodePath === candidate.nodePath) continue;
      if (!arePathsOverlapping(current.mappingPath, candidate.mappingPath)) continue;

      if (current.mappingPath === candidate.mappingPath) {
        issues.push({
          severity: 'error',
          code: 'file-duplicate-mapping',
          rule: 'file-duplicate-mapping',
          nodePath: candidate.nodePath,
          ...issueMsg({
            what: `File '${current.mappingPath}' appears in mappings of multiple nodes:\n  ${current.nodePath}\n  ${candidate.nodePath}`,
            why: `Each source file must have exactly one owner node. Duplicate mappings lead to ambiguous classification and conflicting aspect attribution.`,
            next: `Remove the file from one of the mappings. Decide which node logically owns the file based on its primary role. The other node should reference it via relations if needed.`,
          }),
        });
        continue;
      }

      // Child-precedence (child-wins): an ancestor↔descendant NODE overlap is
      // exempt — the deeper node owns the shared file and the runtime carve-out
      // (getChildMappingExclusions) removes it from the ancestor's subject set,
      // glob-aware, so ownership is unambiguous. Only a NON-hierarchical (sibling)
      // overlap, where there is no "deeper" node to break the tie, is flagged below.
      const isHierarchical =
        isAncestorNode(current.nodePath, candidate.nodePath) ||
        isAncestorNode(candidate.nodePath, current.nodePath);
      if (isHierarchical) continue;

      issues.push({
        severity: 'error',
        code: 'overlapping-mapping',
        rule: 'overlapping-mapping',
        ...issueMsg({
          what: `Mapping paths '${current.mappingPath}' (${current.nodePath}) and '${candidate.mappingPath}' (${candidate.nodePath}) overlap.`,
          why: `Each source file must have exactly one owner node.`,
          next: `Keep one owner mapping and model other concerns via relations.`,
        }),
        nodePath: candidate.nodePath,
      });
    }
  }

  // Glob-aware file-level overlap: the pairwise string check above compares
  // mapping ENTRIES literally, so it cannot see that a glob entry in one node
  // and any entry in another resolve to the SAME file. Resolve every node's
  // mappings to concrete files and flag any file owned by two non-hierarchical
  // nodes (child-wins still allows an ancestor↔descendant pair). Gated on the
  // presence of at least one glob entry so glob-free graphs pay nothing here and
  // their plain↔plain overlaps stay solely on the (already-tested) string pass.
  const anyGlob = [...graph.nodes.values()].some((n) =>
    (n.meta.mapping ?? []).some((e) => isGlobPattern(e)),
  );
  if (anyGlob) {
    const projectRoot = path.dirname(graph.rootPath);
    // An excluded file (a nested project's own boundary, or a coverage.excluded
    // root) belongs to no node — including the two-or-more that a glob would
    // otherwise sweep it into — so it can never be a genuine ownership
    // conflict. Filtered here, before the per-file owner scan below, exactly
    // like every other file-list producer that decides what this graph owns.
    const overlapExclusion = await resolveGraphExclusionSet(projectRoot, graph.config.coverage ?? NO_COVERAGE_EXCLUDED);
    const repoFiles = filterExcludedFromGraph(await walkRepoFiles(projectRoot), overlapExclusion);
    const reported = new Set<string>();
    for (const rawRel of repoFiles) {
      const relPath = normalizePathForCompare(rawRel);
      const owners: string[] = [];
      let viaGlob = false;
      for (const [nodePath, node] of graph.nodes) {
        let matched = false;
        for (const entry of node.meta.mapping ?? []) {
          if (!mappingEntryMatchesFile(entry, relPath)) continue;
          matched = true;
          if (isGlobPattern(entry)) viaGlob = true;
        }
        if (matched) owners.push(nodePath);
      }
      // Only the glob pass's job: plain↔plain overlaps are handled above.
      if (owners.length < 2 || !viaGlob || reported.has(relPath)) continue;
      // Child-precedence: drop any owner that is an ancestor of another owner — the
      // deeper node wins and the runtime carve-out removes the file from the
      // ancestor's subject set (getChildMappingExclusions, glob-aware). What remains
      // are the deepest owners; TWO or more of those are non-hierarchical siblings
      // with no "deeper" tiebreak, which is the genuine ambiguity to flag.
      const leaves = owners.filter(
        (o) => !owners.some((other) => other !== o && isAncestorNode(o, other)),
      );
      if (leaves.length < 2) continue;
      reported.add(relPath);
      issues.push({
        severity: 'error',
        code: 'overlapping-mapping',
        rule: 'overlapping-mapping',
        ...issueMsg({
          what: `File '${relPath}' is owned by multiple non-hierarchical nodes:\n${leaves.map((n) => '  ' + n).join('\n')}`,
          why: `Each source file must have exactly one owner node. A glob mapping in one node resolves to a file also claimed by another node.`,
          next: `Narrow the glob, or remove the file from one node's mapping and model the dependency via a relation.`,
        }),
        nodePath: leaves[0],
      });
    }
  }

  return issues;
}

// --- Rule: Mapping paths should exist on disk (mapping-path-missing) ---

export async function checkMappingPathsExist(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const projectRoot = path.dirname(graph.rootPath);
  const coverage = graph.config.coverage ?? NO_COVERAGE_EXCLUDED;
  for (const [nodePath, node] of graph.nodes) {
    const mappingPaths = normalizeMappingPaths(node.meta.mapping).map(normalizePathForCompare);
    for (const mp of mappingPaths) {
      if (isGlobPattern(mp)) {
        // Deliberately the NEUTRAL expandMappingPaths, not the exclusion-
        // guarded expandMappingPathsWithinOwnGraph: this question is "does the
        // glob resolve to real content on disk at all" (a stale/typo'd
        // pattern), independent of whether that content is excluded. A glob
        // that matches only excluded files is not stale — those files are
        // real — so it must stay silent here; the aggregate, whole-mapping
        // check below (using the guarded expansion) is what catches a mapping
        // that has been entirely swallowed by exclusion.
        const matched = await expandMappingPaths(projectRoot, [mp]);
        if (matched.length === 0) {
          issues.push({
            severity: 'error',
            code: 'mapping-path-missing',
            rule: 'mapping-path-missing',
            ...issueMsg({
              what: `Glob '${mp}' matches no files on disk.`,
              why: `Node maps a glob pattern that currently resolves to no files — possibly all matching files were deleted or the pattern is wrong.`,
              next: `Update mapping in yg-node.yaml: fix the glob or remove the entry.`,
            }),
            nodePath,
          });
        }
      } else {
        const absPath = path.join(projectRoot, mp);
        try {
          await statPath(absPath);
        } catch {
          issues.push({
            severity: 'error',
            code: 'mapping-path-missing',
            rule: 'mapping-path-missing',
            ...issueMsg({
              what: `Mapping path '${mp}' does not exist on disk.`,
              why: `Node maps a file that was deleted or moved.`,
              next: `Update mapping in yg-node.yaml: fix the path or remove the entry.`,
            }),
            nodePath,
          });
        }
      }
    }

    // Aggregate, whole-mapping check: do this node's mapping entries — taken
    // together, not entry by entry — resolve to anything THIS node can
    // actually enforce? A directory or glob entry can resolve to real, on-disk
    // content (so the per-entry checks above stay silent) while EVERY one of
    // those files is excluded from the graph — a nested `.yggdrasil/` graph,
    // a nested `.git` checkout/submodule/worktree, or a `coverage.excluded`
    // root an adopter configured. Left unreported, that node would pass `yg
    // check` with a non-empty `mapping:` and zero enforceable files: the same
    // "resolves to nothing usable" fact mapping-path-missing already reports
    // for a stale glob or a deleted file, just reached through a different
    // cause, so it reuses the same code. Runs over EVERY entry, exact or
    // swept — exclusion is one filter with no carve-out for an entry that
    // names a path exactly, so this aggregate check does not carve one out
    // either (a single exact-entry mapping wholly swallowed by exclusion also
    // trips `checkFileMappingGitignored`'s own per-entry `file-mapping-
    // excluded` diagnostic above; both firing for the same root cause is
    // expected, not a bug — they answer different questions: "is this one
    // entry excluded" versus "does this node have anything left to enforce
    // at all").
    if (mappingPaths.length > 0) {
      const [unguardedWhole, guardedWhole] = await Promise.all([
        expandMappingPaths(projectRoot, mappingPaths),
        expandMappingPathsWithinOwnGraph(projectRoot, mappingPaths, coverage),
      ]);
      if (unguardedWhole.length > 0 && guardedWhole.length === 0) {
        issues.push({
          severity: 'error',
          code: 'mapping-path-missing',
          rule: 'mapping-path-missing',
          ...issueMsg({
            what: `Mapping (${mappingPaths.join(', ')}) resolves only to excluded files; none are left for this node to enforce.`,
            why: `Every file this mapping resolved to is excluded from the graph — inside a separate project's own boundary, or matching a coverage.excluded root — so this node's rules have nothing left to apply to.`,
            next: `Either:\n  1. Remove this mapping (nothing here belongs to this node).\n  2. Point the mapping at files this project actually owns and does not exclude.`,
          }),
          nodePath,
        });
      }
    }
  }
  return issues;
}

// --- mapping-escapes-repo: a mapping entry resolves outside the repo root ---

/**
 * Reject mapping entries that are absolute or climb above the repository root
 * with `..`. normalizeMappingPath only converts separators and strips a leading
 * `./` and trailing slashes — it does NOT collapse `..`, so a mapping like
 * `../../etc/passwd` would otherwise be resolved against the project root and let
 * a node claim files outside the repository, bypassing coverage and enforcement.
 */
export function checkMappingEscapesRepo(graph: Graph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const projectRoot = path.dirname(graph.rootPath);
  for (const [nodePath, node] of graph.nodes) {
    for (const raw of node.meta.mapping ?? []) {
      const norm = normalizePathForCompare(raw);
      const resolved = path.resolve(projectRoot, norm);
      const rel = normalizePathForCompare(path.relative(projectRoot, resolved));
      if (path.isAbsolute(norm) || rel === '..' || rel.startsWith('../')) {
        issues.push({
          severity: 'error',
          code: 'mapping-escapes-repo',
          rule: 'mapping-escapes-repo',
          nodePath,
          ...issueMsg({
            what: `Mapping path '${norm}' in node '${nodePath}' resolves outside the repository root.`,
            why: `A mapping must point to a file inside the repo. An absolute path, or one that climbs above the root with '..', would let a node claim files outside the project — bypassing coverage and aspect enforcement.`,
            next: `Make the mapping repo-relative and within the project: no leading '/', and no '..' segment that climbs above the root.`,
          }),
        });
      }
    }
  }
  return issues;
}

// --- Directories have yg-node.yaml ---

export async function checkDirectoriesHaveNodeYaml(graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const modelDir = path.join(graph.rootPath, 'model');

  async function scanDir(dirPath: string, segments: string[]): Promise<void> {
    const entries = await readSortedDir(dirPath);
    const hasNodeYaml = entries.some((e) => e.isFile() && e.name === 'yg-node.yaml');

    const hasFiles = entries.some((e) => e.isFile());
    const graphPath = segments.join('/');

    if (!hasNodeYaml && graphPath !== '') {
      if (hasFiles) {
        issues.push({
          severity: 'error',
          code: 'node-yaml-missing',
          rule: 'missing-node-yaml',
          ...issueMsg({
            what: `Directory '${graphPath}' has files but no yg-node.yaml.`,
            why: `Every directory in model/ must have a node definition.`,
            next: `Create yg-node.yaml in ${graphPath} or move files to an existing node directory.`,
          }),
          nodePath: graphPath,
        });
      }
      // directory-without-node covered by unmapped-files check
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      await scanDir(path.join(dirPath, entry.name), [...segments, entry.name]);
    }
  }

  try {
    const rootEntries = await readSortedDir(modelDir);
    for (const entry of rootEntries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      await scanDir(path.join(modelDir, entry.name), [entry.name]);
    }
  } catch {
    // model/ may not exist
  }

  return issues;
}
