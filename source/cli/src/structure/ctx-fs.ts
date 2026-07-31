import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FsEntry } from './types.js';
import { normalizeMappingPath, mappingEntryMatchesFile } from '../utils/mapping-path.js';
import { toPosix } from '../utils/posix.js';
import { describeExclusionSource, type ExclusionSource } from '../io/repo-scanner.js';
import type { CoverageConfig } from '../model/graph.js';
import type { ObservationRecorder } from './observations.js';

export interface CtxFsParams {
  allowedSet: Set<string>;
  projectRoot: string;
  /** mutable list — every fs operation appends the normalized path */
  touchedFiles: string[];
  /**
   * Optional observation recorder. When provided, every fs operation records a
   * result-bearing observation (read: list: exists:) UNLESS the path is in
   * `subjectFiles` (own-node files already hashed as subject inputs).
   */
  recorder?: ObservationRecorder;
  /**
   * Set of repo-relative POSIX paths that are subject files for this run.
   * Reads of these paths are NOT recorded as observations — they are hashed
   * separately as subject inputs in the deterministic pair hash.
   */
  subjectFiles?: Set<string>;
  /**
   * Repo-relative POSIX paths of separate-project boundaries below the
   * project root (io/repo-scanner.ts's `findNestedProjectRoots` — a nested
   * `.yggdrasil/` graph, or a nested `.git` checkout/submodule/worktree),
   * computed once per run by the caller. A path under one of these is
   * rejected exactly like an unmapped one, even if `allowedSet` textually
   * covers it (a directory or glob mapping entry can cover a path it never
   * intended to reach into a foreign project) — the same boundary
   * `expandMappingPathsWithinOwnGraph` already draws for `ctx.files` /
   * `ctx.node.files`. Defaults to empty (no boundary applied) so a fixture
   * with nothing to say about nested projects is not forced to thread an
   * unrelated concern through every call — every real runner call site
   * computes and passes the actual set.
   */
  nestedProjectRoots?: ReadonlySet<string>;
  /**
   * The graph's `coverage` config — the adopter-configured half of the same
   * one supreme exclusion filter `nestedProjectRoots` supplies the
   * filesystem-derived half of. A path matching a `coverage.excluded` root is
   * rejected exactly like a path under a nested-project boundary, even if
   * `allowedSet` textually covers it. Defaults to an empty `excluded` list
   * (no adopter-config exclusion applied) for the same reason
   * `nestedProjectRoots` defaults to empty — every real runner call site
   * threads the graph's actual coverage config.
   */
  coverage?: CoverageConfig;
}

export interface CtxFs {
  exists(p: string): 'file' | 'dir' | false;
  list(dir: string): FsEntry[];
  read(p: string): string;
}

export class UndeclaredFsReadError extends Error {
  constructor(
    public readonly path: string,
    /**
     * Which of the two exclusion sources caused this rejection
     * ({@link describeExclusionSource}: `'nested-project'` or `'coverage-excluded'`),
     * or `null` when the read was rejected for a reason exclusion has nothing to do
     * with — a repo-escaping path, or a path simply outside the allow-set. A caller
     * that renders this error for an agent must check this FIRST: a non-null value
     * means no relation or mapping change can ever satisfy the read (the path is
     * gone from graph coverage regardless of what the graph says), so the message
     * must say "excluded from graph coverage by design" instead of prescribing a
     * relation to declare — the same distinction every other exclusion message in
     * the graph already draws. Determined once, at the throw site, so `ctx.fs`,
     * `ctx.parsers`, and companion resolution — the three consumers of this error —
     * render the same fact instead of each re-deriving (or forgetting to re-derive)
     * it independently.
     */
    public readonly exclusionSource: ExclusionSource | null = null,
  ) {
    super(`structure-aspect-undeclared-fs-read: ${path}`);
    this.name = 'UndeclaredFsReadError';
  }
}

function isAllowed(p: string, set: Set<string>): boolean {
  if (p === '') return false;
  if (set.has(p)) return true;
  for (const a of set) {
    // p is an ancestor directory of allowed entry a — permits exists()/list() on
    // the parent dirs of allowed files. Works for a glob entry too via its
    // literal leading prefix (the part before the first metachar).
    if (a.startsWith(p + '/')) return true;
    // p == a, p is under directory a, or p matches glob entry a. The shared
    // matcher handles plain entries (exact / dir-prefix) and glob entries
    // identically, so an allowed-set entry stored as a glob (e.g. a glob node
    // mapping) correctly admits the files it matches.
    if (mappingEntryMatchesFile(a, p)) return true;
  }
  return false;
}

/**
 * Symlink-escape defense. The lexical checks in resolveAllowedReadPath only guard
 * the TEXTUAL path; a symlink inside an allowed path that points OUTSIDE the repo
 * passes them, and the subsequent fs read follows the link out (e.g. an allowed
 * `src/x` that is a symlink to `/etc`). Re-check against the REAL path: realpath
 * the nearest existing ancestor of `abs` and require it to stay within the
 * realpath'd repo root. A non-existent leaf has nothing to follow yet — the
 * lexical check already proved it is textually in-repo, and the read will fail
 * naturally — so only existing ancestors are probed. `projectRoot` itself may sit
 * under a symlink (e.g. /tmp → /private/tmp), so both sides are canonicalized.
 *
 * The SAME symlink also defeats the exclusion check above (in
 * resolveAllowedReadPath), which inspects only `rel` — the TEXTUAL,
 * pre-symlink path — for the same reason it defeats the repo-containment
 * check: an ordinary symlink inside an allowed directory can point INTO a
 * separate project's own boundary, or into a `coverage.excluded` root, just
 * as easily as it can point outside the repo entirely. Re-running the same
 * exclusion test against the REAL path here closes that gap in the same
 * place, and for the same reason, the repo-escape re-check already lives.
 */
function assertRealpathContained(
  abs: string,
  projectRoot: string,
  rel: string,
  nestedProjectRoots: ReadonlySet<string>,
  coverage: CoverageConfig,
): void {
  let realRoot: string;
  try { realRoot = fs.realpathSync(projectRoot); } catch { realRoot = projectRoot; }
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return; // reached the fs root with nothing existing to follow
    probe = parent;
  }
  let realProbe: string;
  try { realProbe = fs.realpathSync(probe); } catch { return; }
  const relReal = toPosix(path.relative(realRoot, realProbe));
  if (relReal === '..' || relReal.startsWith('../') || path.isAbsolute(relReal)) {
    throw new UndeclaredFsReadError(rel);
  }
  const exclusionSource = describeExclusionSource(relReal, { nestedRoots: nestedProjectRoots, coverage });
  if (exclusionSource !== null) {
    throw new UndeclaredFsReadError(rel, exclusionSource);
  }
}

/** No paths excluded — the default when a caller has nothing to say about nested projects. */
const NO_NESTED_PROJECT_ROOTS: ReadonlySet<string> = new Set();

/** No adopter-configured exclusion — the default when a caller has nothing to say about coverage.excluded. */
const NO_COVERAGE_EXCLUDED: CoverageConfig = { required: [], excluded: [], typeLevel: false };

/**
 * Resolve a check.mjs-supplied read path to a safe, allow-set-checked repo-relative path.
 * Rejects absolute paths and any `..` traversal that escapes the repo, rejects a path the
 * graph excludes globally (`nestedProjectRoots` + `coverage` — see CtxFsParams; a separate
 * project's own boundary, or a `coverage.excluded` root), then enforces the allow-set, then
 * re-checks the REAL (symlink-resolved) path is still inside the repo and not excluded either.
 * Throws UndeclaredFsReadError on any violation. Shared by ctx.fs, ctx.parsers AND companion
 * resolution (core/companion-resolve.ts) so the three read-allowance surfaces cannot diverge:
 * a directory or glob mapping entry can textually cover an excluded path it never intended to
 * reach, so the exclusion check runs BEFORE the allow-set check, not folded into it. (This is
 * a read-tracking discipline, not a security sandbox — check.mjs runs with full Node privileges.)
 */
export function resolveAllowedReadPath(
  raw: string,
  allowedSet: Set<string>,
  projectRoot: string,
  nestedProjectRoots: ReadonlySet<string> = NO_NESTED_PROJECT_ROOTS,
  coverage: CoverageConfig = NO_COVERAGE_EXCLUDED,
): string {
  const abs = path.resolve(projectRoot, normalizeMappingPath(raw));
  const rel = toPosix(path.relative(projectRoot, abs));
  // rel === '' (the repo root itself), starts with '..' (escapes repo), or is absolute → reject
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new UndeclaredFsReadError(normalizeMappingPath(raw));
  }
  const exclusionSource = describeExclusionSource(rel, { nestedRoots: nestedProjectRoots, coverage });
  if (exclusionSource !== null) {
    throw new UndeclaredFsReadError(rel, exclusionSource);
  }
  if (!isAllowed(rel, allowedSet)) throw new UndeclaredFsReadError(rel);
  // Symlink-escape defense: the textual path is in-repo and allow-listed, but a
  // symlink could still redirect the real read outside the repo — or into
  // whatever the graph excludes globally. Reject either.
  assertRealpathContained(abs, projectRoot, rel, nestedProjectRoots, coverage);
  return rel;
}

export function createCtxFs(params: CtxFsParams): CtxFs {
  const { allowedSet, projectRoot, touchedFiles, recorder, subjectFiles, nestedProjectRoots, coverage } = params;

  function assertAllowed(raw: string): string {
    const p = resolveAllowedReadPath(raw, allowedSet, projectRoot, nestedProjectRoots, coverage);
    touchedFiles.push(p);
    return p;
  }

  function isSubjectFile(p: string): boolean {
    return subjectFiles !== undefined && subjectFiles.has(p);
  }

  return {
    exists(raw) {
      const p = assertAllowed(raw);
      const abs = path.resolve(projectRoot, p);
      let result: 'file' | 'dir' | false;
      try {
        const stat = fs.statSync(abs);
        result = stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : false;
      } catch {
        result = false;
      }
      if (recorder && !isSubjectFile(p)) {
        recorder.recordExists(p, result);
      }
      return result;
    },

    read(raw) {
      const p = assertAllowed(raw);
      const abs = path.resolve(projectRoot, p);
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(abs);
      } catch (err) {
        // Over-record (spec §3.1): the read passed the allow-check but threw
        // (missing/unreadable). Fold an absent observation BEFORE re-throwing so a
        // check that swallows the throw and treats the file as absent invalidates
        // when the file later appears.
        if (recorder && !isSubjectFile(p)) recorder.recordReadAbsent(p);
        throw err;
      }
      if (recorder && !isSubjectFile(p)) {
        recorder.recordRead(p, bytes);
      }
      return bytes.toString('utf8');
    },

    list(raw) {
      const p = assertAllowed(raw);
      const abs = path.resolve(projectRoot, p);
      let dirents;
      try {
        dirents = fs.readdirSync(abs, { withFileTypes: true });
      } catch (err) {
        // Over-record (spec §3.1): the list passed the allow-check but threw.
        // Fold an absent observation BEFORE re-throwing (mirrors read).
        if (recorder && !isSubjectFile(p)) recorder.recordListAbsent(p);
        throw err;
      }
      const entries = dirents.map(e => ({
        name: e.name,
        kind: e.isDirectory() ? ('dir' as const) : ('file' as const),
      }));
      if (recorder && !isSubjectFile(p)) {
        recorder.recordList(p, entries);
      }
      return entries;
    },
  };
}
