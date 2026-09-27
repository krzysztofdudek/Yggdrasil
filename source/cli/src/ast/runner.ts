import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ensureLoaderRegistered } from './loader-hook.js';
import { parseFile } from './parser.js';
import type { IssueMessage } from '../model/validation.js';
import { collectSuppressions, isLineSuppressed, SuppressMarkerError } from './suppress.js';
import { validateCheckModuleExport } from '../utils/validate-check-module.js';
import { getLanguageForExtension } from '../utils/language-registry.js';
import type { Tree } from 'web-tree-sitter';
import type { CheckContext, SourceFile, Violation } from './types.js';
import type { ParseCache } from '@chrisdudek/runes/ast';

export { type ParseCache } from '@chrisdudek/runes/ast';

export interface RunAstAspectParams {
  aspectDir: string;
  aspectId: string;
  /**
   * The files the check runs over. `path` is what the check sees in
   * `ctx.files[].path` and what its violations must name; `readFrom`, when set,
   * is the project-relative file the bytes are read from instead. Only `yg drill`
   * sets it: a case file lives under the rule's corpus but is seen under the path
   * it has inside its case directory, so a rule anchored on a path prefix drills
   * the way it runs.
   */
  files: Array<{ path: string; readFrom?: string }>;
  projectRoot: string;
  parseCache?: ParseCache;
  /**
   * The rule's settled configuration, handed to the check as `ctx.config`. A
   * graphless run has no graph, but it does have the rule — and a rule
   * parameterized through `ctx.config` (the only way a package rule is) could
   * not otherwise run here at all.
   */
  config?: Record<string, string | number | boolean>;
}

export interface RunAstAspectResult {
  violations: Violation[];
}

export class AstRunnerError extends Error {
  public readonly messageData: IssueMessage;
  constructor(public readonly code: string, data: IssueMessage) {
    super(`${data.what}\n${data.why}\n${data.next}`);
    this.messageData = data;
    this.name = 'AstRunnerError';
  }
}

/**
 * Thrown by a trapping ctx accessor when a check reads graph context in a
 * graphless run. It DISTINGUISHES "this check needs the graph → unsupported
 * here" from "this check has a bug": the runner catches it and rethrows an
 * `AstRunnerError('AST_GRAPH_CTX_UNSUPPORTED')` BEFORE the generic
 * `AST_CHECK_THROWN` wrap. It never escapes `runAstAspect`.
 */
export class GraphAccessTrap extends Error {
  constructor(public readonly accessor: string) {
    super(`graph accessor '${accessor}' is unavailable in a graphless run`);
    this.name = 'GraphAccessTrap';
  }
}

export { SuppressMarkerError };

/**
 * The one `ctx` a graphless run hands a check — `yg drill` over its case files
 * and `yg aspect-test --files` over the given files alike, so a check behaves
 * the same under both. What such a run CAN supply, it does: the files are the
 * whole subject of the run (`files` and `subject`), and the rule's settings
 * are the ones it would see in the gate (`config`). Every other member of the
 * production Ctx contract (structure/types.ts `Ctx`) is a getter that throws
 * GraphAccessTrap the instant a check reads it, so a graph-aware check surfaces
 * as unsupported here rather than as a bug in the check. Keep that list in sync
 * with `Ctx`: a member left off would read as undefined and misreport the check
 * as broken. Everything but `files` is non-enumerable, so the object still
 * serializes and inspects as `{ files }`.
 */
function graphlessCtx(sourceFiles: SourceFile[], config: RunAstAspectParams['config']): CheckContext {
  const ctx: CheckContext = { files: sourceFiles };
  Object.defineProperty(ctx, 'subject', { configurable: true, enumerable: false, value: sourceFiles });
  Object.defineProperty(ctx, 'config', { configurable: true, enumerable: false, value: Object.freeze({ ...(config ?? {}) }) });
  for (const accessor of ['node', 'graph', 'fs', 'parseAst', 'parseYaml', 'parseJson', 'parseToml'] as const) {
    Object.defineProperty(ctx, accessor, {
      configurable: true,
      enumerable: false,
      get() {
        throw new GraphAccessTrap(accessor);
      },
    });
  }
  return ctx;
}

export async function runAstAspect(params: RunAstAspectParams): Promise<RunAstAspectResult> {
  ensureLoaderRegistered();

  const checkPath = path.resolve(params.projectRoot, params.aspectDir, 'check.mjs');

  let mod: Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(checkPath).href) as Record<string, unknown>;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
      throw new AstRunnerError('AST_LOADER_RESOLVE_FAILED', {
        what: `Could not resolve a module imported by check.mjs (aspect '${params.aspectId}').`,
        why: `Missing module: ${(e as Error).message}.`,
        next: `Reinstall the CLI or remove the unresolved import from check.mjs.`,
      });
    }
    throw e;
  }

  const exportCheck = validateCheckModuleExport(mod, {
    codePrefix: 'AST',
    runnerLabel: `aspect '${params.aspectId}'`,
  });
  if (!exportCheck.ok) {
    throw new AstRunnerError(exportCheck.code, exportCheck.message);
  }
  // The shared validator guarantees mod.check is a single-arg function; capture
  // a typed reference for the invocation below (the removed inline guards
  // previously provided this narrowing).
  const checkFn = mod.check as (...args: unknown[]) => unknown;

  // Trees parsed here without an external parseCache are locally owned and must
  // be deleted before this function exits (web-tree-sitter WASM objects are not
  // GC'd). Trees handed to params.parseCache are the caller's responsibility.
  const localTrees: Tree[] = [];
  const sourceFiles: SourceFile[] = [];
  try {
  for (const f of params.files) {
    const cached = params.parseCache?.get(f.path);
    if (cached !== undefined) {
      sourceFiles.push({ path: f.path, content: cached.content, ast: cached.ast });
      continue;
    }
    const content = await readFile(path.resolve(params.projectRoot, f.readFrom ?? f.path), 'utf-8');
    // A file whose extension has no registered grammar is non-parseable: deliver
    // it to check() with ast === undefined so content/regex rules can still
    // iterate it (parity with the graph-aware structure runner and the documented
    // contract). Only files with a registered grammar are parsed and AST-cached.
    if (getLanguageForExtension(path.extname(f.path).toLowerCase()) === null) {
      sourceFiles.push({ path: f.path, content, ast: undefined });
      continue;
    }
    let ast: Tree;
    try {
      ast = await parseFile(f.path, content);
    } catch (e: unknown) {
      const msg = (e as Error).message ?? String(e);
      // The extension is registered (checked above), so a failure here is a real
      // grammar-load infrastructure error — fail closed.
      throw new AstRunnerError('AST_GRAMMAR_LOAD_FAILED', {
        what: `Failed to load tree-sitter grammar for ${f.path}: ${msg}`,
        why: `The bundled WASM grammar could not be loaded.`,
        next: `Reinstall the CLI.`,
      });
    }
    // Register for local cleanup immediately — before any early-exit path
    // below. If we later transfer ownership to params.parseCache, we pop
    // from localTrees so the outer finally does not double-delete.
    if (!params.parseCache) {
      localTrees.push(ast);
    }
    // Deliver the parsed tree BEST-EFFORT even when it carries parse errors
    // (ast.rootNode.hasError). This mirrors the production check runner exactly:
    // the structure runner's prewarmupAstCache (structure/ctx-parsers.ts) parses
    // and caches the tree without ever inspecting hasError. Because this runner is
    // the harness behind `yg drill` / `yg aspect-test` (its only callers), aborting
    // the case on a parse error diverged the harness from production — a content-only
    // check (e.g. a raw-control-byte scan that never reads file.ast) could not be
    // drilled with a syntactically-broken same-extension fixture, even though
    // `yg check --approve` refuses that same file cleanly. Delivering the tree
    // best-effort closes that fidelity gap: the content-only check runs, and an
    // AST-consuming check receives the identical error-laden tree production hands
    // it — no new harness/production divergence. A genuinely malformed fixture is
    // not hidden: an AST-consuming check reading a broken subtree yields the same
    // result it would in the gate, which is the faithful signal to the author.
    if (params.parseCache) {
      params.parseCache.set(f.path, { content, ast });
    }
    sourceFiles.push({ path: f.path, content, ast });
  }

  // Collect suppressions BEFORE invoking check. Parseable files use their AST
  // comments; non-parseable files (ast undefined) fall back to a raw-line scan
  // of their content, so a yg-suppress marker is honored in any language.
  // A reasonless marker is collected with its fault and fails only a violation
  // it would have waived (see the filter below).
  const rangesPerFile = new Map<string, ReturnType<typeof collectSuppressions>>();
  for (const f of sourceFiles) {
    const totalLines = f.content.split('\n').length;
    rangesPerFile.set(f.path, collectSuppressions(f.ast, f.path, totalLines, f.content));
  }

  const ctx = graphlessCtx(sourceFiles, params.config);
  let raw: unknown;
  try {
    raw = checkFn(ctx);
  } catch (e: unknown) {
    // A GraphAccessTrap means the check read graph context the drill cannot
    // supply — reclassify it as unsupported BEFORE the generic runtime-error wrap
    // so `yg drill` records the case as a capability gap, never a check bug.
    if (e instanceof GraphAccessTrap) {
      throw new AstRunnerError('AST_GRAPH_CTX_UNSUPPORTED', {
        what: `check.mjs for aspect '${params.aspectId}' read graph context (ctx.${e.accessor}), which a run over files alone does not provide.`,
        why: `yg drill and yg aspect-test --files run check.mjs over the given files only (ctx.files and ctx.subject, with the rule's settings as ctx.config); a check that needs node / graph / fs / parseAst / parseYaml / parseJson / parseToml cannot run there. This is a limit of the run, not a bug in the check.`,
        next: `yg aspect-test --aspect ${params.aspectId} --node <a node it applies to>`,
      });
    }
    throw new AstRunnerError('AST_CHECK_THROWN', {
      what: `check.mjs threw an exception while running (aspect '${params.aspectId}').`,
      why: (e instanceof Error ? e.stack : undefined) ?? String(e),
      next: `Fix the bug in .yggdrasil/aspects/${params.aspectId}/check.mjs, then re-run the check that ran it.`,
      step: { file: `.yggdrasil/aspects/${params.aspectId}/check.mjs` },
    });
  }

  if (raw !== null && typeof raw === 'object' && typeof (raw as Record<string, unknown>).then === 'function') {
    // The returned promise is refused, not awaited — so its rejection must be
    // caught here. Left unhandled, an async check that throws takes the whole
    // process down with a bare `Error:` line and no report, after the refusal
    // below was already on its way to the caller.
    Promise.resolve(raw).catch(() => {});
    throw new AstRunnerError('AST_CHECK_ASYNC', {
      what: `check.mjs returned a Promise; only synchronous returns are supported in v1.`,
      why: `The runner does not await check's return value.`,
      next: `Make check() in .yggdrasil/aspects/${params.aspectId}/check.mjs synchronous: return the Violation[] itself, not a Promise.`,
      step: { file: `.yggdrasil/aspects/${params.aspectId}/check.mjs` },
    });
  }

  if (!Array.isArray(raw)) {
    throw new AstRunnerError('AST_CHECK_RETURN_SHAPE', {
      what: `check.mjs returned ${typeof raw}, expected Violation[].`,
      why: `The runner reports violations from the array returned by check.`,
      next: `Make check() in .yggdrasil/aspects/${params.aspectId}/check.mjs return [] or a Violation[].`,
      step: { file: `.yggdrasil/aspects/${params.aspectId}/check.mjs` },
    });
  }

  // Enforce ctx.files boundary — check.mjs must not synthesize violations for files it was not given
  const contextPaths = new Set(sourceFiles.map(f => f.path));
  for (const v of raw as Violation[]) {
    if (!contextPaths.has(v.file)) {
      throw new AstRunnerError('AST_CHECK_FILE_NOT_IN_CONTEXT', {
        what: `check.mjs returned a Violation referencing file '${v.file}' which is not in ctx.files (aspect '${params.aspectId}').`,
        why: `Author cannot synthesize violations against files they were not given. Suppress markers cannot reach unknown files.`,
        next: `Make check() in .yggdrasil/aspects/${params.aspectId}/check.mjs report only files in ctx.files (the array passed to check).`,
        step: { file: `.yggdrasil/aspects/${params.aspectId}/check.mjs` },
      });
    }
  }

  // Filter suppressed violations. A violation of this aspect inside the range of
  // a reasonless marker naming it throws: a fault in the subject file's marker,
  // not in check.mjs — surfaced as its own diagnostic so the failure is never
  // misattributed to the aspect's check.
  let filtered: Violation[];
  try {
    filtered = (raw as Violation[]).filter(v => {
      const ranges = rangesPerFile.get(v.file);
      if (!ranges) return true;
      return !isLineSuppressed(ranges, params.aspectId, v.line);
    });
  } catch (e: unknown) {
    if (e instanceof SuppressMarkerError) {
      throw new AstRunnerError('AST_SUPPRESS_MARKER_MALFORMED', e.messageData);
    }
    throw e;
  }

  return { violations: filtered };
  } finally {
    for (const t of localTrees) t.delete();
  }
}
