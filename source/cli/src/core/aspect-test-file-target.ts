// Classification for a `yg aspect-test --file <path>` target: a file
// enforced by its architecture type alone (no owning component), addressed
// by the architecture type it matches instead of a node path.
//
// `aspect-test.ts` (a `command`-type file) owns the two checks that need
// command-layer-only access — the on-disk existence probe and the
// `findOwner` ownership check (`findOwner` lives in `./owner.js`, itself a
// `command`-type file; the `engine` type this module carries cannot legally
// call another command's export). This module owns everything AFTER those
// two checks pass: is coverage.type_level even on, is the path excluded from
// coverage, does it classify to exactly one non-strict architecture type,
// and — on success — what that type's `relations:` let it legally reach.
import type { Graph } from '../model/graph.js';
import type { TypeCoverageInput } from './pairs.js';
import { classifySingleFile, computeTypeCoverage } from './type-coverage.js';
import { walkRepoFiles, resolveGraphExclusionSet, isExcludedFromGraph, isCoverageExcludedPath, NO_COVERAGE_EXCLUDED } from '../io/repo-scanner.js';
import { FileContentCache } from '../io/file-content-cache.js';
import { scanUncoveredFiles } from './check.js';
import { collectArchitectureReach } from '../structure/allowed-reads.js';
import { buildOwnerIndex } from '../relations/owner-index.js';

/**
 * The type-level classification lattice (coverage.type_level), classified for
 * one `yg aspect-test` invocation. Undefined when the flag is off, so a
 * caller's `computeExpectedPairs` enumerates exactly the component-only
 * universe it always has. Two callers in aspect-test.ts need this SAME
 * classification: `classifyAspectTestFileTarget` below (to compute the
 * matched type's architecture-permitted reach) and --node's own LLM dispatch
 * (to filter nodeless pairs out of a node-scoped lookup) — both call this one
 * function rather than scanning the repo's uncovered files twice per
 * invocation.
 */
export async function computeTypeCoverageForAspectTest(
  graph: Graph,
  projectRoot: string,
): Promise<TypeCoverageInput | undefined> {
  if (!graph.config.coverage?.typeLevel) return undefined;
  const gitFiles = await walkRepoFiles(projectRoot);
  const uncovered = scanUncoveredFiles(graph, gitFiles);
  const result = await computeTypeCoverage(graph, uncovered, new FileContentCache());
  return { covered: result.covered, ambiguousPaths: result.ambiguous.map((a) => a.file) };
}

/**
 * The architecture-permitted read allowance for a nodeless (type-covered, no
 * owning component) unit — "what can a file of THIS type legally reach."
 * Shared by `classifyAspectTestFileTarget` below and aspect-test.ts's
 * companion-diagnostic path (resolveCompanionsForTest), which both need the
 * identical computation for a nodeless subject rather than each rebuilding an
 * owner index and calling collectArchitectureReach separately. Builds a fresh
 * owner index per call — cheap, and matches this codebase's own per-call
 * convention elsewhere (relations/pass.ts, core/fill-det.ts,
 * core/companion-resolve.ts all do the same).
 */
export async function computeNodelessArchitectureReach(
  graph: Graph,
  projectRoot: string,
  file: string,
  fromType: string,
  typeCovered: Map<string, string>,
): Promise<Set<string>> {
  return collectArchitectureReach(file, {
    fromType,
    typeCovered,
    architecture: graph.architecture,
    graph,
    projectRoot,
    ownerIndex: buildOwnerIndex(graph.nodes),
  });
}

/**
 * A `--file <path>` target: a file with no owning component, addressed by the
 * architecture type it matches instead of a node path. `--node` resolves a
 * component; `--file` resolves this. `refused` names WHY the path cannot be
 * addressed this way — untyped/ambiguous classification (fix the architecture
 * or map a node), an excluded path, the flag being off, or (constructed by
 * aspect-test.ts itself, BEFORE this module ever runs) a path that already
 * exists nowhere or already has a component.
 */
export type AspectTestFileTarget =
  | { kind: 'ok'; file: string; typeId: string; typeCoverage: TypeCoverageInput; allowedReads: string[] }
  | { kind: 'refused'; messageData: { what: string; why: string; next: string } };

/** WHAT/NEXT for every non-'covered' classification bucket a --file target can land in. */
function describeFileTargetClassificationProblem(
  file: string,
  single: Awaited<ReturnType<typeof classifySingleFile>>,
): { what: string; next: string } {
  switch (single.bucket) {
    case 'ambiguous':
      return {
        what: `'${file}' is ambiguous: it matches ${single.typeIds.length} architecture types (${single.typeIds.join(', ')}).`,
        next: `Narrow the architecture's when: predicates so at most one type matches this file, or map it to a node and use --node.`,
      };
    case 'strict':
      return {
        what: `'${file}' matches strict type '${single.strictTypeId}', which requires an explicit node mapping, not --file addressing.`,
        next: `Map this file to a node of type '${single.strictTypeId}' and use --node.`,
      };
    case 'unreadable':
      return {
        what: `'${file}' could not be classified: ${single.reason}.`,
        next: `Fix the file's readability, or use --files for an ad-hoc, ungraphed run.`,
      };
    case 'unmatched':
    default:
      return {
        what: `'${file}' matches no architecture type.`,
        next: `Map this file to a node and use --node, or add a matching type to yg-architecture.yaml.`,
      };
  }
}

/**
 * Classify an already-existing, already-unowned `--file <path>` target
 * (aspect-test.ts's orchestrator runs those two checks first — see the file
 * header): refuse when coverage.type_level is off, when the path is excluded
 * from coverage, or when it does not classify to exactly one non-strict
 * architecture type (naming the problem); on success, resolve the matched
 * type's architecture-permitted read allowance
 * (computeNodelessArchitectureReach) for a deterministic run and the
 * file/typeCoverage a nodeless LLM pair lookup needs.
 */
export async function classifyAspectTestFileTarget(
  graph: Graph,
  projectRoot: string,
  repoRelative: string,
): Promise<AspectTestFileTarget> {
  if (!graph.config.coverage?.typeLevel) {
    return {
      kind: 'refused',
      messageData: {
        what: `'${repoRelative}' cannot be addressed by --file — type-level coverage is off.`,
        why: `--file only ever addresses a file classified by coverage.type_level; with the flag off, no file is ever classified this way.`,
        next: `Enable coverage.type_level in .yggdrasil/yg-config.yaml, or use --node / --files instead.`,
      },
    };
  }
  const exclusionSet = await resolveGraphExclusionSet(projectRoot, graph.config.coverage ?? NO_COVERAGE_EXCLUDED);
  if (isCoverageExcludedPath(repoRelative) || isExcludedFromGraph(repoRelative, exclusionSet)) {
    return {
      kind: 'refused',
      messageData: {
        what: `'${repoRelative}' is excluded from coverage.`,
        why: `--file addresses a file the architecture classifies by type; an excluded path is never classified — because it sits inside a separate project's own boundary, or matches a coverage.excluded root.`,
        next: `Remove it from coverage.excluded (or move it outside the separate project's own boundary), or use --files for an ad-hoc, ungraphed run.`,
      },
    };
  }

  const cache = new FileContentCache();
  const single = await classifySingleFile(graph, repoRelative, cache);
  if (single.bucket !== 'covered') {
    const { what, next } = describeFileTargetClassificationProblem(repoRelative, single);
    return {
      kind: 'refused',
      messageData: {
        what,
        why: `--file requires the path to match EXACTLY one non-strict architecture type — anything else has no single rule set to test.`,
        next,
      },
    };
  }

  // Guaranteed defined: the flag-off case already returned above.
  const typeCoverage = (await computeTypeCoverageForAspectTest(graph, projectRoot))!;
  const reach = await computeNodelessArchitectureReach(graph, projectRoot, repoRelative, single.typeId, typeCoverage.covered);

  return { kind: 'ok', file: repoRelative, typeId: single.typeId, typeCoverage, allowedReads: [...reach] };
}
