import { UndeclaredFsReadError } from './ctx-fs.js';
import { UndeclaredGraphReadError } from './ctx-graph.js';
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

// StructureRunnerError is defined in hook-loader.ts (shared by the loader and
// this runner without a circular import); re-export it here so existing importers
// (structure/index.ts, callers keying off the runner module) are unaffected.
export { StructureRunnerError } from './hook-loader.js';

// Distinct code stamped when a `yg-suppress` marker in a mapped source file is
// malformed (reasonless). The filler keys on this to surface a "malformed suppress
// marker" diagnostic instead of blaming the aspect's check.mjs — a marker-parse
// failure is a fault in the source file, not in check.mjs.
export const SUPPRESS_MARKER_MALFORMED_CODE = 'STRUCTURE_SUPPRESS_MARKER_MALFORMED';

export interface RunStructureAspectParams {
  aspectDir: string;
  aspectId: string;
  nodePath: string;
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
  const { aspectDir, aspectId, nodePath, graph, projectRoot, subjectScope } = params;
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
    aspectId, nodePath, graph, projectRoot, astCache, touchedFiles, subjectScope,
  });

  let raw: unknown;
  try {
    raw = checkFn(ctx);
  } catch (err) {
    if (err instanceof UndeclaredFsReadError) {
      return {
        violations: [{
          message: `Aspect tried to read undeclared path '${err.path}'. Add a relation in yg-node.yaml to the node owning this path.`,
          kind: 'structure-aspect-undeclared-fs-read',
          file: `.yggdrasil/aspects/${aspectId}/check.mjs`,
        }],
        touchedFiles: [],
        succeeded: false,
        observations: recorder.snapshot(),
        observationsTainted: recorder.tainted,
      };
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
    if (err instanceof ParseAstNotPrewarmedError) {
      return {
        violations: [{
          message: `Aspect called ctx.parseAst on '${err.filePath}', which was not pre-warmed by the dispatcher. Add a declared relation to the node owning this file, or use ctx.parseYaml/Json/Toml if AST is not required.`,
          kind: 'structure-aspect-parseast-not-prewarmed',
          file: `.yggdrasil/model/${nodePath}/yg-node.yaml`,
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
