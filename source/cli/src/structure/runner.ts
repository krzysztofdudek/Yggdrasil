import { UndeclaredFsReadError } from './ctx-fs.js';
import { describeExclusionCause } from '../io/repo-scanner.js';
import { UndeclaredGraphReadError, StructureNodeContextUnavailableError } from './ctx-graph.js';
import { ParseAstNotPrewarmedError } from './ctx-parsers.js';
import { normalizeMappingPath } from './expand-mapping-sync.js';
import { collectSuppressions, isLineSuppressed, SuppressMarkerError } from '../ast/suppress.js';
import type { SuppressedRange } from '../ast/suppress.js';
import { validateCheckModuleExport } from '../utils/validate-check-module.js';
import type { Graph } from '../model/graph.js';
import type { Violation } from './types.js';
import type { ParseCache } from '../ast/parse-cache.js';
import { destroyParseCache } from '../ast/parse-cache.js';
import { StructureRunnerError, loadHookModule, buildUnitCtx } from './hook-loader.js';
import type { StructureUnit } from './hook-loader.js';

// StructureRunnerError is defined in hook-loader.ts (shared by the loader and
// this runner without a circular import); re-export it here so existing importers
// (structure/index.ts, callers keying off the runner module) are unaffected.
export { StructureRunnerError } from './hook-loader.js';
// StructureUnit likewise: defined in hook-loader.ts (BuildUnitCtxParams lives
// there); re-exported here so callers addressing a deterministic run (fill-det.ts,
// det-worker-core.ts, det-worker-pool.ts) import the addressing type from the
// runner module they already depend on.
export type { StructureUnit } from './hook-loader.js';

// Distinct code stamped when a `yg-suppress` marker in a mapped source file is
// malformed (reasonless). The filler keys on this to surface a "malformed suppress
// marker" diagnostic instead of blaming the aspect's check.mjs — a marker-parse
// failure is a fault in the source file, not in check.mjs.
export const SUPPRESS_MARKER_MALFORMED_CODE = 'STRUCTURE_SUPPRESS_MARKER_MALFORMED';

export interface RunStructureAspectParams {
  aspectDir: string;
  aspectId: string;
  unit: StructureUnit;
  graph: Graph;
  projectRoot: string;
  parseCache?: ParseCache;
  /**
   * Subject-scope override for a `per: file` deterministic pair (spec §1, B2
   * contract #8). When present, it overrides BOTH `ctx.files` (the check sees
   * only these subject files) AND the observation-EXCLUSION set (a read of any
   * OTHER node file folds as a recorded `read:` observation, since it is no
   * longer hashed as a subject input). Repo-relative POSIX paths.
   *
   * `ctx.node.files` and the allow-set stay NODE-scoped regardless — the check
   * may still reach the rest of the node, but those reaches become observations.
   *
   * Absent → byte-identical legacy behavior (the whole node mapping is both the
   * subject set and the exclusion set; `per: node` and `yg aspect-test` paths).
   */
  subjectScope?: string[];
}

export interface RunStructureAspectResult {
  violations: Violation[];
  touchedFiles: string[];
  succeeded?: boolean;
  /** Sorted [observationKey, observationHash] pairs recorded during this run. */
  observations: Array<[string, string]>;
  /** True when the same path was observed with different content during the run
   *  (file changed mid-run) — a tainted result must never be cached. */
  observationsTainted: boolean;
}

export async function runStructureAspect(
  params: RunStructureAspectParams,
): Promise<RunStructureAspectResult> {
  const { aspectDir, aspectId, unit, graph, projectRoot, subjectScope } = params;
  const ownCache = !params.parseCache;
  const astCache: ParseCache = params.parseCache ?? new Map();
  const touchedFiles: string[] = [];
  try {

  // Load + validate check.mjs (deterministic hook). loadHookModule registers the
  // ESM loader and imports the module; the shared export-shape ladder confirms a
  // named, single-arg, callable `check` before we build the ctx.
  const mod = await loadHookModule({ aspectDir, projectRoot, filename: 'check.mjs' });
  const exportCheck = validateCheckModuleExport(mod, {
    codePrefix: 'STRUCTURE',
    runnerLabel: `aspect '${aspectId}'`,
  });
  if (!exportCheck.ok) {
    throw new StructureRunnerError(exportCheck.code, exportCheck.message);
  }
  const checkFn = mod.check as (...args: unknown[]) => unknown;

  // Build the unit-scoped ctx (shared with the companion resolver). This is the
  // byte-behavior-preserving head: same recorder, touchedFiles, subjectFiles set,
  // ctx identity, and AST prewarmup as the legacy inline construction.
  const { ctx, recorder, ownFiles, astInputSet } = await buildUnitCtx({
    aspectId, unit, graph, projectRoot, astCache, touchedFiles, subjectScope,
  });

  let raw: unknown;
  try {
    raw = checkFn(ctx);
  } catch (err) {
    if (err instanceof UndeclaredFsReadError) {
      // An excluded path (err.exclusionSource set) is a DIFFERENT fact from an
      // undeclared one: no relation, mapping, or architecture change can ever
      // make it readable — it is gone from graph coverage regardless of what
      // the graph says. Report that fact directly, the same wording every
      // other exclusion message in the graph uses, instead of falling into
      // the relation/widen advice below, which would send an agent looping on
      // a fix that cannot work.
      if (err.exclusionSource !== null) {
        throw new StructureRunnerError('STRUCTURE_UNDECLARED_FS_READ', {
          what: `Aspect tried to read '${err.path}', which is excluded from graph coverage by design.`,
          why: `No relation, mapping, or architecture change can make this path readable — it is never matched against any node or type because ${describeExclusionCause(err.exclusionSource)}.`,
          next: `Remove the read of '${err.path}' from check.mjs, or read only a non-excluded, relation-reachable file.`,
        });
      }
      // An undeclared read is never a bug IN check.mjs — the remedy is always
      // an architecture or graph change (widen a relation, or give the file/
      // node a component of its own), never a code fix. Throw a structured
      // StructureRunnerError (like STRUCTURE_NODE_CONTEXT_UNAVAILABLE below)
      // so that real remedy reaches the printed output through fill-det.ts's
      // originalMessageData thread, instead of being returned as a Violation
      // whose `next` the caller can only guess at (and guesses "fix check.mjs",
      // which is wrong here). Split at the SAME sentence boundaries the prior
      // single-string message used, so the wording an agent sees is unchanged.
      throw new StructureRunnerError('STRUCTURE_UNDECLARED_FS_READ', unit.kind === 'file'
        ? {
            what: `Aspect tried to read undeclared path '${err.path}'.`,
            why: `This file has no component of its own — its only reads beyond its own content are files the architecture's relations: allow-list permits '${unit.typeId}' to depend on.`,
            next: `Allow '${unit.typeId}' to depend on whatever owns '${err.path}' in yg-architecture.yaml, or give '${unit.file}' a component of its own (a yg-node.yaml mapping it) so it can declare an explicit relation instead.`,
          }
        : {
            what: `Aspect tried to read undeclared path '${err.path}'.`,
            why: `check.mjs may only read files inside the node's allowed reads set (its own mapping, declared relation targets, ancestors, and descendants) — this path is outside all of them.`,
            next: `Add a relation in yg-node.yaml to the node owning this path.`,
          });
    }
    if (err instanceof UndeclaredGraphReadError) {
      return {
        violations: [{
          message: `Aspect tried to read undeclared graph node '${err.nodePath}'. Add a relation in yg-node.yaml.`,
          kind: 'structure-aspect-undeclared-graph-read',
          file: `.yggdrasil/aspects/${aspectId}/check.mjs`,
        }],
        touchedFiles: [],
        succeeded: false,
        observations: recorder.snapshot(),
        observationsTainted: recorder.tainted,
      };
    }
    // ctx.node / ctx.graph accessed on a unit with no owning component: a typed,
    // fail-closed infra disposition (never a Violation) — thrown, not returned,
    // exactly like every other STRUCTURE_* structural fault. Both exits named:
    // make the rule file-local to files the architecture already permits this
    // type to reach, or give the file a component of its own.
    if (err instanceof StructureNodeContextUnavailableError) {
      throw new StructureRunnerError('STRUCTURE_NODE_CONTEXT_UNAVAILABLE', {
        what: `check.mjs for aspect '${aspectId}' accessed ctx.${err.member}, which is unavailable here.`,
        why: `This file has no owning component — it is enforced by its architecture type alone, so there is no yg-node.yaml to back ctx.node or ctx.graph.`,
        next: `Rewrite the check to use only ctx.subject / ctx.fs over files the architecture already permits this file's type to reach, or give the file a component of its own (a yg-node.yaml mapping it) so ctx.node / ctx.graph become available.`,
      });
    }
    if (err instanceof ParseAstNotPrewarmedError) {
      return {
        violations: [{
          message: `Aspect called ctx.parseAst on '${err.filePath}', which was not pre-warmed by the dispatcher. Add a declared relation to the node owning this file, or use ctx.parseYaml/Json/Toml if AST is not required.`,
          kind: 'structure-aspect-parseast-not-prewarmed',
          // A nodeless unit has no component file to point at — name the
          // aspect's own check.mjs instead (there is no yg-node.yaml here).
          file: unit.kind === 'node'
            ? `.yggdrasil/model/${unit.nodePath}/yg-node.yaml`
            : `.yggdrasil/aspects/${aspectId}/check.mjs`,
        }],
        touchedFiles: [],
        succeeded: false,
        observations: recorder.snapshot(),
        observationsTainted: recorder.tainted,
      };
    }
    throw new StructureRunnerError('STRUCTURE_CHECK_THROWN', {
      what: `check.mjs threw an exception while running (aspect '${aspectId}').`,
      why: `${(err as Error).message}\n${(err as Error).stack ?? ''}`,
      next: `Fix the bug in check.mjs, then re-run: yg check --approve`,
    });
  }

  if (raw !== null && typeof raw === 'object' && typeof (raw as Record<string, unknown>).then === 'function') {
    throw new StructureRunnerError('STRUCTURE_CHECK_ASYNC', {
      what: `check.mjs returned a Promise; only synchronous returns are supported.`,
      why: `The runner does not await check's return value.`,
      next: `Refactor check to be synchronous.`,
    });
  }
  if (!Array.isArray(raw)) {
    throw new StructureRunnerError('STRUCTURE_CHECK_RETURN_SHAPE', {
      what: `check.mjs returned ${typeof raw}, expected Violation[].`,
      why: `The runner reports violations from the array returned by check.`,
      next: `Return [] or Violation[] from check.`,
    });
  }

  const contextFiles = new Set<string>(ownFiles.map(f => f.path));
  for (const t of touchedFiles) contextFiles.add(t);

  const violations: Violation[] = [];
  for (const v of raw) {
    if (typeof v !== 'object' || v === null || typeof (v as Violation).message !== 'string') {
      throw new StructureRunnerError('STRUCTURE_CHECK_RETURN_SHAPE', {
        what: `Violation entry must be an object with a string 'message' field.`,
        why: `The runner renders each violation from its message and optional file/line.`,
        next: `Return objects shaped { message: string, file?: string, line?: number } from check.`,
      });
    }
    const vv = v as Violation;
    if (typeof vv.file === 'string' && !contextFiles.has(normalizeMappingPath(vv.file))) {
      throw new StructureRunnerError('STRUCTURE_CHECK_FILE_NOT_IN_CONTEXT', {
        what: `Violation references file '${vv.file}' not in ctx (own mapping or touched via ctx.fs/ctx.graph).`,
        why: `Author cannot synthesize violations against files they were not given.`,
        next: `Return only violations for files in ctx, or declare a relation to the node owning '${vv.file}'.`,
      });
    }
    violations.push(vv);
  }

  // Filter suppressed violations. Ranges for a parseable file come from its
  // parsed tree in the astCache (own files are eagerly parsed; cross-node files
  // the check parsed are cached). A non-parseable file (no registered grammar)
  // is not in the astCache, so its ranges come from a raw-line scan of its
  // content, sourced here from the own/related file sets the runner already read.
  // A violation with no file/line, or in a file with neither tree nor content,
  // is not suppressible.
  const contentByPath = new Map<string, string>();
  for (const f of [...ownFiles, ...astInputSet]) {
    contentByPath.set(normalizeMappingPath(f.path), f.content);
  }
  const rangesByFile = new Map<string, SuppressedRange[] | null>();
  function rangesFor(filePath: string): SuppressedRange[] | null {
    const existing = rangesByFile.get(filePath);
    if (existing !== undefined) return existing;
    const cached = astCache.get(filePath);
    let ranges: SuppressedRange[] | null;
    try {
      if (cached) {
        ranges = collectSuppressions(cached.ast, filePath, cached.content.split('\n').length, cached.content);
      } else {
        const content = contentByPath.get(filePath);
        ranges = content !== undefined
          ? collectSuppressions(undefined, filePath, content.split('\n').length, content)
          : null;
      }
    } catch (err) {
      // A malformed suppress marker is a fault in the SOURCE file's marker, not in
      // check.mjs. Re-raise it as a runner error with a DISTINCT code so the
      // filler surfaces its own "malformed suppress marker" diagnostic instead of
      // an aspect-check-runtime-error that blames the (correct) check.
      if (err instanceof SuppressMarkerError) {
        throw new StructureRunnerError(SUPPRESS_MARKER_MALFORMED_CODE, err.messageData);
      }
      throw err;
    }
    rangesByFile.set(filePath, ranges);
    return ranges;
  }
  const visible = violations.filter(v => {
    if (typeof v.file !== 'string' || typeof v.line !== 'number') return true;
    const ranges = rangesFor(normalizeMappingPath(v.file));
    if (!ranges) return true;
    return !isLineSuppressed(ranges, aspectId, v.line);
  });

    return {
      violations: visible,
      touchedFiles,
      succeeded: true,
      observations: recorder.snapshot(),
      observationsTainted: recorder.tainted,
    };
  } finally {
    if (ownCache) destroyParseCache(astCache);
  }
}
