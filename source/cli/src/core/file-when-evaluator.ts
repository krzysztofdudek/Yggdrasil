import { globMatch } from '../utils/mapping-path.js';
import type {
  FileWhenPredicate,
  PredicateTrace,
  EvaluationResult,
} from '../model/file-when.js';
import type { FileContentCache } from '../io/file-content-cache.js';

const YGGDRASIL_PREFIX = '.yggdrasil/';

/**
 * Bound the INPUT LENGTH a content-predicate regex scans (256KB head). This
 * caps the linear cost of a well-behaved pattern on a large file — it does NOT
 * bound worst-case execution time: a catastrophically-backtracking pattern
 * (e.g. nested quantifiers like `(a+)+`) is exponential in input length and can
 * still hang on far fewer than 256KB characters. Node's RegExp runs
 * synchronously and cannot be interrupted or timed out, so there is no
 * in-process wall-clock bound here; the `catch` is a guard for a thrown engine
 * error, not a timeout (V8 does not throw on slow backtracking — it blocks).
 *
 * A `content:` regex is authored inside the trust boundary (yg-architecture.yaml
 * or an aspect's scope.files, both human-confirmed edits), so this is a
 * robustness footgun, not an external attack surface: keep content predicates
 * simple and avoid nested/overlapping quantifiers. A genuine wall-clock bound
 * would require evaluating the match off the main thread (a worker with a hard
 * timeout) — deliberately deferred as a designed change rather than a
 * heuristic ReDoS reject that could wrongly block a legitimate pattern.
 */
function safeRegexTest(re: RegExp, str: string): { match: boolean; timeout?: boolean } {
  const HEAD_LIMIT = 256 * 1024;
  const head = str.length > HEAD_LIMIT ? str.slice(0, HEAD_LIMIT) : str;
  try {
    return { match: re.test(head) };
  } catch {
    return { match: false, timeout: true };
  }
}

export type EvalContext = {
  /** Absolute path to the file. */
  absPath: string;
  /** Repo-relative POSIX path (forward slashes). */
  repoRelPath: string;
  /** Absolute path to project root. */
  projectRoot: string;
  /** Per-run content cache. */
  cache: FileContentCache;
};

/**
 * Evaluate a FileWhenPredicate against a file. Returns boolean result plus
 * trace structure suitable for rendering predicate evaluation trees in
 * error messages.
 *
 * Auto-exempts paths under `.yggdrasil/` (returns vacuously true).
 */
export async function evaluateFileWhen(
  predicate: FileWhenPredicate,
  ctx: EvalContext,
): Promise<EvaluationResult> {
  if (ctx.repoRelPath.startsWith(YGGDRASIL_PREFIX)) {
    return {
      result: true,
      trace: { kind: 'exempt', result: true, reason: '.yggdrasil/ auto-exempt' },
    };
  }

  return evaluatePredicate(predicate, ctx);
}

async function evaluatePredicate(
  predicate: FileWhenPredicate,
  ctx: EvalContext,
): Promise<EvaluationResult> {
  if ('all_of' in predicate) {
    const children: PredicateTrace[] = [];
    let allPass = true;
    // A DEFINITIVELY false child (one that resolved false without itself
    // being unreadable) makes the whole all_of false no matter what any
    // unreadable sibling would have resolved to — the combination can never
    // match, so it must be a clean non-match, not an unresolved one. This is
    // what makes `{ path, content }` (desugared to all_of just below) skip a
    // content read entirely when the path atom alone already disqualifies
    // the file: an unreadable/oversized content atom never turns a
    // path-mismatched file into a blocking file-unreadable error.
    let hasDefinitiveFalse = false;
    let unreadable = false;
    let unreadableReason: string | undefined;
    let unreadableKind: 'read' | 'too-large' | undefined;
    for (const child of predicate.all_of) {
      const r = await evaluatePredicate(child, ctx);
      children.push(r.trace);
      if (!r.result) allPass = false;
      if (!r.result && !r.unreadable) hasDefinitiveFalse = true;
      if (r.unreadable) {
        unreadable = true;
        unreadableReason ??= r.unreadableReason;
        unreadableKind ??= r.unreadableKind;
      }
    }
    const propagateUnreadable = unreadable && !hasDefinitiveFalse;
    return {
      result: allPass,
      ...(propagateUnreadable && { unreadable: true, unreadableReason, unreadableKind }),
      trace: { kind: 'all_of', result: allPass, children },
    };
  }

  if ('any_of' in predicate) {
    const children: PredicateTrace[] = [];
    let anyPass = false;
    let unreadable = false;
    let unreadableReason: string | undefined;
    let unreadableKind: 'read' | 'too-large' | undefined;
    for (const child of predicate.any_of) {
      const r = await evaluatePredicate(child, ctx);
      children.push(r.trace);
      if (r.result) anyPass = true;
      if (r.unreadable) {
        unreadable = true;
        unreadableReason ??= r.unreadableReason;
        unreadableKind ??= r.unreadableKind;
      }
    }
    return {
      result: anyPass,
      ...(unreadable && !anyPass && { unreadable, unreadableReason, unreadableKind }),
      trace: { kind: 'any_of', result: anyPass, children },
    };
  }

  if ('not' in predicate) {
    const r = await evaluatePredicate(predicate.not, ctx);
    return {
      result: !r.result,
      ...(r.unreadable && { unreadable: true, unreadableReason: r.unreadableReason, unreadableKind: r.unreadableKind }),
      trace: { kind: 'not', result: !r.result, child: r.trace },
    };
  }

  return evaluateAtomic(predicate, ctx);
}

async function evaluateAtomic(
  predicate: { path?: string; content?: string },
  ctx: EvalContext,
): Promise<EvaluationResult> {
  if (predicate.path !== undefined && predicate.content !== undefined) {
    return evaluatePredicate(
      { all_of: [{ path: predicate.path }, { content: predicate.content }] },
      ctx,
    );
  }

  if (predicate.path !== undefined) {
    const matches = globMatch(ctx.repoRelPath, predicate.path);
    return {
      result: matches,
      trace: { kind: 'atom-path', pattern: predicate.path, result: matches },
    };
  }

  if (predicate.content !== undefined) {
    const fileContent = await ctx.cache.read(ctx.absPath);
    if (fileContent.unreadable) {
      return {
        result: false,
        unreadable: true,
        unreadableReason: fileContent.unreadableReason ?? 'unreadable',
        unreadableKind: 'read',
        trace: {
          kind: 'atom-content',
          pattern: predicate.content,
          result: false,
          detail: 'file unreadable',
        },
      };
    }
    // Deliberate asymmetry between the two non-readable content cases:
    //   - binary  → a legitimate NON-MATCH (no text content for a text regex to
    //               match; binaries are excluded from LLM subjects by design).
    //               Excluded from the subject set, NEVER blocks.
    //   - tooLarge → UNEVALUABLE. The filter could not be applied, so we must NOT
    //               silently exclude the file (that would let an enforced rule pass
    //               vacuously over source no reviewer saw). Signal `unreadable` so
    //               the caller records it in the blocking unreadable[] channel,
    //               exactly like an EACCES read failure above.
    if (fileContent.isBinary) {
      return {
        result: false,
        trace: {
          kind: 'atom-content',
          pattern: predicate.content,
          result: false,
          detail: 'file is binary (null bytes detected)',
        },
      };
    }
    if (fileContent.tooLarge) {
      return {
        result: false,
        unreadable: true,
        unreadableReason: 'file exceeds the 5MB scan limit (content filter could not be evaluated)',
        unreadableKind: 'too-large',
        trace: {
          kind: 'atom-content',
          pattern: predicate.content,
          result: false,
          detail: 'file >5MB, content filter could not be evaluated',
        },
      };
    }
    let regex: RegExp;
    try {
      regex = new RegExp(predicate.content);
    } catch {
      // Defense-in-depth: a malformed content regex is rejected by the parser
      // (when-predicate-invalid) before evaluation, so this is normally
      // unreachable. If a caller bypasses the parser, fail closed (no match)
      // rather than throwing an uncaught SyntaxError into validation.
      return {
        result: false,
        trace: { kind: 'atom-content', pattern: predicate.content, result: false, detail: 'invalid content regex' },
      };
    }
    const { match: matches } = safeRegexTest(regex, fileContent.content!);
    return {
      result: matches,
      trace: { kind: 'atom-content', pattern: predicate.content, result: matches },
    };
  }

  return {
    result: false,
    trace: { kind: 'atom-path', pattern: '<empty>', result: false, detail: 'empty atomic' },
  };
}
