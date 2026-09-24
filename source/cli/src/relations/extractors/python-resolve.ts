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
 * `isExcluded`, when supplied, makes an excluded candidate act as though it does not
 * exist, in BOTH resolvers. In the absolute resolver this happens at two levels: per
 * ancestor source root, the priority list (a package, then a same-named module-as-file
 * — CPython's own precedence) no longer stops at the first EXISTING candidate — an
 * excluded one is skipped so a live candidate further down the SAME root's list (a
 * module-as-file surviving its own excluded same-named package) still reaches the
 * per-root match; and across roots, an excluded root's match is dropped from the
 * ambiguity count before deciding whether a dotted module resolved to one file or
 * several — the search probes every ancestor source root and treats 2+ DISTINCT live
 * matches as genuinely ambiguous (ANOTHER root or a same-named shadow really might be
 * the target, so a static tool must not guess which), while a single live match is
 * unambiguous even when a second, now-excluded match also exists. The relative
 * resolver has no cross-root ambiguity to decide — only the same per-root priority
 * list — so it applies the same "skip an excluded hit, try the next candidate" rule
 * to that one list. Either way an excluded file is graph-told to not exist for this
 * purpose: it can never BE the real target, so its match must not keep a real,
 * surviving candidate silenced merely because it once shared a name or a dotted
 * module with a file the graph no longer considers. This mirrors the Go/Java package
 * resolvers' drop-then-decide rule. Absent → no candidate is ever dropped (today's
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
  projectRoots?: () => readonly string[],
): string | undefined {
  if (specifier.startsWith('.')) {
    return resolveRelative(specifier, fromFile, exists, isExcluded);
  }
  return resolveAbsolute(specifier, fromFile, exists, isExcluded, projectRoots);
}

/**
 * Top-level standard-library module names (CPython 3.13 `sys.stdlib_module_names` without
 * the private `_x` modules, plus the modules removed in 3.12/3.13 and added in 3.14, so an
 * older or newer interpreter is covered). A DISCOVERED project root (see resolveAbsolute)
 * is on `sys.path` only because its project is installed, and installed projects come after
 * the standard library, so a module there named like one of these can never shadow it.
 */
const PYTHON_STDLIB_TOP_LEVEL: ReadonlySet<string> = new Set(
  (
    'abc annotationlib antigravity argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb binascii ' +
    'bisect builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys ' +
    'compileall compression concurrent configparser contextlib contextvars copy copyreg crypt csv ctypes curses ' +
    'dataclasses datetime dbm decimal difflib dis distutils doctest email encodings ensurepip enum errno ' +
    'faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc genericpath getopt getpass gettext ' +
    'glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io ipaddress ' +
    'itertools json keyword lib2to3 linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap ' +
    'modulefinder msilib msvcrt multiprocessing netrc nis nntplib nt ntpath nturl2path numbers opcode operator ' +
    'optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath ' +
    'pprint profile pstats pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue quopri random re readline ' +
    'reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtpd ' +
    'smtplib sndhdr socket socketserver spwd sqlite3 sre_compile sre_constants sre_parse ssl stat statistics ' +
    'string stringprep struct subprocess sunau symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile ' +
    'termios textwrap this threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty ' +
    'turtle turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser ' +
    'winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo'
  ).split(' '),
);

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
 * An ancestor directory INSIDE A REGULAR PACKAGE is never a root: one that holds an
 * `__init__.py`, or whose parent does (a namespace sub-directory of a regular package).
 * `sys.path` only ever holds directories outside packages, so `import logging` in
 * `app/api/routes.py` loads the standard library even when the package `app/` has a
 * `logging.py`, and must not bind to it.
 *
 * `projectRoots`, when supplied, adds the source roots discovered repo-wide from project
 * manifests (a src-layout project's `src/`, each uv/Poetry workspace member's root), so a
 * test outside `src/` or one workspace member importing another resolves although the
 * root is no ancestor of the importing file. A discovered root is on `sys.path` only
 * because its project is installed, after the standard library, so a top-level name the
 * standard library owns is never matched there. Discovered roots join the SAME distinct-
 * match count, so a module found under two roots still stays silent.
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
  projectRoots?: () => readonly string[],
): string | undefined {
  const segments = specifier.split('.').filter((s) => s.length > 0);
  if (segments.length === 0) return undefined;

  const modulePath = segments.join('/'); // a/b/c
  const parentPath = segments.slice(0, -1).join('/'); // a/b (drop last segment)

  // Probe EVERY ancestor source root and collect the DISTINCT files that match.
  // The importing file's own dir and the intermediate dirs are NOT genuine
  // absolute-import roots, so a same-named module sitting in the importer's own
  // package must not shadow the real source root. Resolving the same dotted
  // module to 2+ distinct LIVE files means we cannot tell which root is genuine —
  // silence (undefined) per the zero-false-positive rule. A single distinct live
  // file is an unambiguous resolution and is returned.
  //
  // Per-root, the candidate priority order is preserved (module-as-file/package
  // first, then the parentPath longest-match): only the first LIVE hit at each
  // root is added to the set, so a root that matches both the full module and its
  // parent still contributes just one file (the stronger match wins) — but an
  // EXCLUDED hit does not stop the search at that root: it is skipped exactly
  // like a genuine miss, so a live candidate further down the SAME root's list
  // (a package outranking its own excluded same-named module, matching CPython's
  // real precedence) still reaches the match set.
  const isExcl = isExcluded ?? ((): boolean => false);
  const matches = new Set<string>();
  const roots = ancestorDirs(path.posix.dirname(toPosix(fromFile))).filter(
    (dir) => !insideRegularPackage(dir, exists),
  );
  if (projectRoots !== undefined && !PYTHON_STDLIB_TOP_LEVEL.has(segments[0])) {
    for (const root of projectRoots()) {
      if (!roots.includes(root) && !insideRegularPackage(root, exists)) roots.push(root);
    }
  }
  for (const dir of roots) {
    const candidates: string[] = [
      // package / module-as-file at this root — CPython imports a regular
      // package over a same-named module file (verified against the real
      // interpreter: `import lib.mod` loads lib/mod/__init__.py even when
      // lib/mod.py also exists at the same root).
      joinUnder(dir, modulePath + '/__init__.py'),
      joinUnder(dir, modulePath + '.py'),
    ];
    // `from a.b import c` longest-match: last segment is a symbol in module a.b.
    if (parentPath.length > 0) {
      candidates.push(joinUnder(dir, parentPath + '/__init__.py'));
      candidates.push(joinUnder(dir, parentPath + '.py'));
    }
    for (const cand of candidates) {
      if (cand !== undefined && exists(cand) && !isExcl(cand)) {
        matches.add(cand);
        break; // only the strongest LIVE match per root contributes to the set
      }
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

/**
 * Relative module: a leading run of `k` dots then an optional dotted tail. CPython
 * semantics: 1 dot = the importing file's own package (its directory), each extra
 * dot climbs one parent. So climb `(k - 1)` directories from the importing file's
 * directory, append the tail path, then try `<base>/__init__.py` and `<base>.py`
 * (a package before a same-named module-as-file, the same priority order the
 * absolute resolver uses). An excluded candidate is skipped exactly like a genuine miss, so
 * a live package sitting right next to its own excluded same-named module still
 * resolves — there is only one base here, so no cross-root ambiguity to decide.
 */
function resolveRelative(
  specifier: string,
  fromFile: string,
  exists: (repoRelPosix: string) => boolean,
  isExcluded?: (repoRelPosix: string) => boolean,
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
      ? [path.posix.join(normalized, '__init__.py'), normalized + '.py']
      : [path.posix.join(normalized, '__init__.py')]; // bare dots → the package's __init__

  const isExcl = isExcluded ?? ((): boolean => false);
  for (const cand of candidates) {
    if (exists(cand) && !isExcl(cand)) return cand;
  }
  return undefined;
}

/** True when `dir` is inside a regular package, so it can never be a `sys.path` root: it
 *  holds an `__init__.py` itself, or its parent does (a namespace sub-directory of a regular
 *  package). The repo root has no parent inside the repo. */
function insideRegularPackage(dir: string, exists: (repoRelPosix: string) => boolean): boolean {
  if (exists(joinUnder(dir, '__init__.py'))) return true;
  if (dir === '') return false;
  const parent = path.posix.dirname(dir);
  return exists(joinUnder(parent === '.' ? '' : parent, '__init__.py'));
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
