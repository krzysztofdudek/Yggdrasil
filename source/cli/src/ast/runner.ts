import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ensureLoaderRegistered } from './loader-hook.js';
import { parseFile } from './parser.js';
import type { IssueMessage } from '../model/validation.js';
import { collectSuppressions, isLineSuppressed, SuppressMarkerError } from './suppress.js';
import { validateCheckModuleExport } from '../utils/validate-check-module.js';
import { getLanguageForExtension } from '../core/graph/language-registry.js';
import type { Node, Tree } from 'web-tree-sitter';
import type { CheckContext, SourceFile, Violation } from './types.js';
import type { ParseCache } from './parse-cache.js';

export { type ParseCache } from './parse-cache.js';

export interface RunAstAspectParams {
  aspectDir: string;
  aspectId: string;
  files: Array<{ path: string }>;
  projectRoot: string;
  parseCache?: ParseCache;
  /**
   * When true, `ctx.node`, `ctx.graph`, `ctx.fs`, and `ctx.parseYaml` become
   * getters that throw {@link GraphAccessTrap} the instant a check reads them.
   * Set ONLY by `yg drill` (whose graphless case-file runs cannot supply graph
   * context); unset EVERYWHERE else, so for every production path `ctx` stays
   * exactly `{ files }` — zero behavior change. Under a false/absent value, a
   * check that dereferences `ctx.node` sees `undefined` and throws a TypeError
   * that wraps as `AST_CHECK_THROWN`, exactly as before this flag existed.
   */
  graphAccessTrap?: boolean;
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
 * Thrown by a trapping ctx accessor when a check reads graph context under a
 * drill (`graphAccessTrap: true`). It DISTINGUISHES "this check needs the graph
 * → unsupported by drill v1" from "this check has a bug → unrun": the runner
 * catches it and rethrows an `AstRunnerError('AST_GRAPH_CTX_UNSUPPORTED')`
 * BEFORE the generic `AST_CHECK_THROWN` wrap. It never escapes `runAstAspect`.
 */
export class GraphAccessTrap extends Error {
  constructor(public readonly accessor: string) {
    super(`graph accessor '${accessor}' is unavailable under yg drill`);
    this.name = 'GraphAccessTrap';
  }
}

export { SuppressMarkerError };

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
    const content = await readFile(path.resolve(params.projectRoot, f.path), 'utf-8');
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
    if (ast.rootNode.hasError) {
      const err = findFirstErrorNode(ast.rootNode);
      throw new AstRunnerError('AST_SOURCE_PARSE_ERROR', {
        what: `Source file ${f.path} has a syntax error at line ${(err?.startPosition.row ?? 0) + 1}.`,
        why: `Tree-sitter could not parse the file cleanly.`,
        next: `Fix the syntax error in ${f.path}.`,
      });
    }
    if (params.parseCache) {
      params.parseCache.set(f.path, { content, ast });
    }
    sourceFiles.push({ path: f.path, content, ast });
  }

  // Collect suppressions BEFORE invoking check. Parseable files use their AST
  // comments; non-parseable files (ast undefined) fall back to a raw-line scan
  // of their content, so a yg-suppress marker is honored in any language.
  const rangesPerFile = new Map<string, ReturnType<typeof collectSuppressions>>();
  try {
    for (const f of sourceFiles) {
      const totalLines = f.content.split('\n').length;
      rangesPerFile.set(f.path, collectSuppressions(f.ast, f.path, totalLines, f.content));
    }
  } catch (e: unknown) {
    // A malformed suppress marker is a fault in the subject file's marker, not in
    // check.mjs — surface it as its own diagnostic so the failure is never
    // misattributed to the aspect's check.
    if (e instanceof SuppressMarkerError) {
      throw new AstRunnerError('AST_SUPPRESS_MARKER_MALFORMED', e.messageData);
    }
    throw e;
  }

  // Production paths pass `graphAccessTrap` false/unset, so `ctx` is EXACTLY
  // `{ files }` for them (byte-for-byte the pre-existing object — zero behavior
  // change). Only `yg drill` sets the trap: then the four graph-context accessors
  // become getters that throw GraphAccessTrap the instant a check reads them, so a
  // graph-aware check surfaces as `unsupported` (a capability gap) rather than
  // `unrun` (a bug). The properties are non-enumerable so the object still
  // serializes/inspects as `{ files }`.
  const ctx: CheckContext = { files: sourceFiles };
  if (params.graphAccessTrap) {
    for (const accessor of ['node', 'graph', 'fs', 'parseYaml'] as const) {
      Object.defineProperty(ctx, accessor, {
        configurable: true,
        enumerable: false,
        get() {
          throw new GraphAccessTrap(accessor);
        },
      });
    }
  }
  let raw: unknown;
  try {
    raw = checkFn(ctx);
  } catch (e: unknown) {
    // A GraphAccessTrap means the check read graph context the drill cannot
    // supply — reclassify it as unsupported BEFORE the generic runtime-error wrap
    // so `yg drill` records the case as a capability gap, never a check bug.
    if (e instanceof GraphAccessTrap) {
      throw new AstRunnerError('AST_GRAPH_CTX_UNSUPPORTED', {
        what: `check.mjs for aspect '${params.aspectId}' read graph context (ctx.${e.accessor}), which yg drill does not provide.`,
        why: `yg drill runs check.mjs over the case files only (ctx.files); a check that needs node / graph / fs / parseYaml cannot run in a graphless drill.`,
        next: `The case is recorded as unsupported (not scored). Verify this aspect through yg check --approve, which supplies full graph context.`,
      });
    }
    throw new AstRunnerError('AST_CHECK_THROWN', {
      what: `check.mjs threw an exception while running (aspect '${params.aspectId}').`,
      why: (e instanceof Error ? e.stack : undefined) ?? String(e),
      next: `Fix the bug in check.mjs, then re-run: yg check --approve`,
    });
  }

  if (raw !== null && typeof raw === 'object' && typeof (raw as Record<string, unknown>).then === 'function') {
    throw new AstRunnerError('AST_CHECK_ASYNC', {
      what: `check.mjs returned a Promise; only synchronous returns are supported in v1.`,
      why: `The runner does not await check's return value.`,
      next: `Refactor check to be synchronous.`,
    });
  }

  if (!Array.isArray(raw)) {
    throw new AstRunnerError('AST_CHECK_RETURN_SHAPE', {
      what: `check.mjs returned ${typeof raw}, expected Violation[].`,
      why: `The runner reports violations from the array returned by check.`,
      next: `Return [] or Violation[] from check.`,
    });
  }

  // Enforce ctx.files boundary — check.mjs must not synthesize violations for files it was not given
  const contextPaths = new Set(sourceFiles.map(f => f.path));
  for (const v of raw as Violation[]) {
    if (!contextPaths.has(v.file)) {
      throw new AstRunnerError('AST_CHECK_FILE_NOT_IN_CONTEXT', {
        what: `check.mjs returned a Violation referencing file '${v.file}' which is not in ctx.files (aspect '${params.aspectId}').`,
        why: `Author cannot synthesize violations against files they were not given. Suppress markers cannot reach unknown files.`,
        next: `Return only violations for files in ctx.files (the array passed to check).`,
      });
    }
  }

  // Filter suppressed violations
  const filtered = (raw as Violation[]).filter(v => {
    const ranges = rangesPerFile.get(v.file);
    if (!ranges) return true;
    return !isLineSuppressed(ranges, params.aspectId, v.line);
  });

  return { violations: filtered };
  } finally {
    for (const t of localTrees) t.delete();
  }
}

function findFirstErrorNode(node: Node): Node | null {
  if (node.isError) return node;
  for (const child of node.children) {
    const found = findFirstErrorNode(child);
    if (found) return found;
  }
  return null;
}
