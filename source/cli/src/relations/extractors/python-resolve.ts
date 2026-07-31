import path from 'node:path';

/**
 * Resolve a Python module specifier to a repo-relative POSIX source file, or undefined.
 *
 * The specifier is what the extractor emits: either an ABSOLUTE dotted module path
 * (`foo.bar`, no leading dot) or a RELATIVE one (a leading run of dots, then an
 * optional dotted tail — `.`, `..`, `.sib`, `..pkg.mod`).
 *
 * `exists(repoRelPosix)` reports whether a candidate file exists in the resolution
 * universe (disk at --approve time; a fixed known-set in unit tests). PURE except
 * through `exists` and `isExcluded`. Resolution is a pure file-existence search — no
 * directory listing, no graph access. The owner index downstream maps the resolved
 * file to a node; an unmapped resolved file is simply not a known target.
 *
 * `isExcluded`, when supplied, drops an excluded candidate from the ambiguity count
 * BEFORE the absolute resolver decides whether a dotted module resolved to one file
 * or several. The absolute search probes every ancestor source root and treats 2+
 * DISTINCT existing files as genuinely ambiguous (ANOTHER root or a same-named
 * shadow really might be the target, so a static tool must not guess which). An
 * excluded file is graph-told to not exist for this purpose: it can never BE the
 * real target, so its match must not count toward "this is ambiguous" once a
 * single non-excluded candidate is what remains. This mirrors the Go/Java package
 * resolvers' drop-then-decide rule, applied to the per-root candidate SET instead
 * of a package's file list. Absent → no candidate is ever dropped (today's
 * behavior, unaffected).
 *
 * RESOLUTION MISS → undefined. This fail-to-silence is the single most important
 * false-positive guard: a stdlib/third-party module, a mis-climbed relative import,
 * or any module whose file is not present resolves to nothing and is never flagged.
 */
export function resolvePythonModule(
  specifier: string,
  fromFile: string,
  exists: (repoRelPosix: string) => boolean,
  isExcluded?: (repoRelPosix: string) => boolean,
): string | undefined {
  if (specifier.startsWith('.')) {
    return resolveRelative(specifier, fromFile, exists);
  }
  return resolveAbsolute(specifier, fromFile, exists, isExcluded);
}

/**
 * Absolute dotted module `a.b.c`. Without a directory listing we approximate
 * CPython's source-root search: for the importing file's directory and every
 * ancestor directory up to (and including) the repo root, probe the module as a
 * file/package rooted at that directory. For `from a.b import c` the LAST segment
 * may be a symbol rather than a submodule, so also probe the parent module
 * (`a/b.py`, `a/b/__init__.py`) for the longest-match. We probe EVERY ancestor
 * root (the importer's own/intermediate dirs are not genuine roots, so they must
 * not shadow the real source root): a single distinct matching file is returned;
 * 2+ distinct matches are ambiguous and resolve to undefined (silence).
 *
 * An excluded match is dropped BEFORE that ambiguity count. It is graph-told to
 * not exist, so it can never be the genuine target and must not keep a real,
 * surviving match silenced merely because it once shared a dotted module name
 * with a file the graph no longer considers.
 */
function resolveAbsolute(
  specifier: string,
  fromFile: string,
  exists: (repoRelPosix: string) => boolean,
  isExcluded?: (repoRelPosix: string) => boolean,
): string | undefined {
  const segments = specifier.split('.').filter((s) => s.length > 0);
  if (segments.length === 0) return undefined;

  const modulePath = segments.join('/'); // a/b/c
  const parentPath = segments.slice(0, -1).join('/'); // a/b (drop last segment)

  // Probe EVERY ancestor source root and collect the DISTINCT files that match.
  // The importing file's own dir and the intermediate dirs are NOT genuine
  // absolute-import roots, so a same-named module sitting in the importer's own
  // package must not shadow the real source root. Resolving the same dotted
  // module to 2+ distinct files means we cannot tell which root is genuine —
  // silence (undefined) per the zero-false-positive rule. A single distinct
  // file is an unambiguous resolution and is returned.
  //
  // Per-root, the candidate priority order is preserved (module-as-file/package
  // first, then the parentPath longest-match): only the first hit at each root
  // is added to the set, so a root that matches both the full module and its
  // parent still contributes just one file (the stronger match wins).
  const matches = new Set<string>();
  for (const dir of ancestorDirs(path.posix.dirname(toPosix(fromFile)))) {
    const candidates: string[] = [
      // module-as-file / package at this root
      joinUnder(dir, modulePath + '.py'),
      joinUnder(dir, modulePath + '/__init__.py'),
    ];
    // `from a.b import c` longest-match: last segment is a symbol in module a.b.
    if (parentPath.length > 0) {
      candidates.push(joinUnder(dir, parentPath + '.py'));
      candidates.push(joinUnder(dir, parentPath + '/__init__.py'));
    }
    for (const cand of candidates) {
      if (cand !== undefined && exists(cand)) {
        matches.add(cand);
        break; // only the strongest match per root contributes to the set
      }
    }
  }
  // Drop any excluded match before deciding whether resolution is ambiguous — the
  // same drop-then-decide rule the Go/Java package resolvers apply to a package's
  // file list, applied here to the per-root candidate set. Exactly one live match
  // remaining is an unambiguous resolution even when a second, now-excluded match
  // also exists; zero or 2+ live matches stay silent, unchanged.
  const isExcl = isExcluded ?? ((): boolean => false);
  const live = [...matches].filter((m) => !isExcl(m));
  return live.length === 1 ? live[0] : undefined;
}

/**
 * Relative module: a leading run of `k` dots then an optional dotted tail. CPython
 * semantics: 1 dot = the importing file's own package (its directory), each extra
 * dot climbs one parent. So climb `(k - 1)` directories from the importing file's
 * directory, append the tail path, then try `<base>.py` and `<base>/__init__.py`.
 */
function resolveRelative(
  specifier: string,
  fromFile: string,
  exists: (repoRelPosix: string) => boolean,
): string | undefined {
  const dotMatch = specifier.match(/^\.+/);
  if (dotMatch === null) return undefined;
  const dots = dotMatch[0].length;
  const tail = specifier.slice(dots); // "" | "sib" | "pkg.mod"

  // Start from the importing file's directory; climb (dots - 1) parents.
  let base = path.posix.dirname(toPosix(fromFile));
  for (let i = 0; i < dots - 1; i++) {
    const parent = path.posix.dirname(base);
    if (parent === base) return undefined; // climbed above repo root → miss
    base = parent;
  }

  const tailPath = tail.length > 0 ? tail.split('.').filter((s) => s.length > 0).join('/') : '';
  const target = tailPath.length > 0 ? path.posix.join(base, tailPath) : base;
  const normalized = path.posix.normalize(target);
  if (normalized.startsWith('..')) return undefined; // escaped the repo → miss

  const candidates =
    tailPath.length > 0
      ? [normalized + '.py', path.posix.join(normalized, '__init__.py')]
      : [path.posix.join(normalized, '__init__.py')]; // bare dots → the package's __init__

  for (const cand of candidates) {
    if (exists(cand)) return cand;
  }
  return undefined;
}

/** The importing file's directory and every ancestor directory up to the repo root,
 *  nearest-first. '' (the repo root) is the final entry. */
function ancestorDirs(dir: string): string[] {
  const out: string[] = [];
  let cur = dir === '.' ? '' : dir;
  for (;;) {
    out.push(cur);
    if (cur === '') break;
    const parent = path.posix.dirname(cur);
    cur = parent === '.' ? '' : parent;
  }
  return out;
}

/** Join a repo-relative directory with a sub-path, normalizing. '' → the sub-path itself. */
function joinUnder(dir: string, sub: string): string {
  return path.posix.normalize(dir === '' ? sub : path.posix.join(dir, sub));
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
