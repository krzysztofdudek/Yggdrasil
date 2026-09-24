import path from 'node:path';

/**
 * Resolve a C/C++ `#include` header name to a repo-relative POSIX source file, or undefined.
 * Shared by both the C (`.c`/`.h`) and C++ (`.cpp`/`.hpp`/…) dispatch branches — the
 * include mechanism is identical across the two grammars.
 *
 * The specifier is what the extractor emits: the header name as written for a quoted
 * include (`db/foo.h`), or `<name>` for an angle include (`<util/log.hpp>`).
 *
 * HEADER/IMPL SPLIT: an include always names the HEADER file, never the implementation
 * translation unit. The resolved header's OWNING NODE is the dependency target; a header
 * owned by no node maps to nothing and the dependency is SILENT (a coverage matter, never a
 * violation) — the resolver's job ends at producing the file path.
 *
 * Resolution order, mirroring the compiler ([cpp.include], GCC/Clang search order):
 *   1. QUOTED only: the including file's own directory (`<dir-of-includer>/<name>`). A hit
 *      here is what the compiler takes first, so it wins outright.
 *   2. The include ROOTS, when `roots` is supplied:
 *      - with a compilation database (`compile_commands.json`), the translation unit's own
 *        `-iquote` roots (quoted includes only) and `-I` roots, read from the flags the
 *        compiler actually used; a header that is not itself a translation unit takes the
 *        roots of every unit in the database. `-isystem` roots are never used.
 *      - without a database, a conservative PROBE of the repository root and every
 *        directory named `include`, for QUOTED includes whose name has at least two
 *        segments and no `.`/`..` segment. A bare `"config.h"` is never probed (it is the
 *        likeliest name of a generated or foreign header) and an angle include is never
 *        probed (without the real `-I` list an in-repo header and a system one look alike).
 *      Across the roots the EXACTLY-ONE-HIT rule applies: one distinct existing file →
 *      resolved; 0 or 2+ → silence. The compiler would take the first root in flag order,
 *      but a header included from another header is compiled under whichever unit includes
 *      it, so a static tool does not bet on the order — the same rule PHP applies to PSR-4
 *      roots and Java/Go to split packages.
 * A MISS → undefined, i.e. SILENCE. Excluded files (`isExcluded`) are dropped from the hit
 * set before the exactly-one decision. A name that is absolute, empty, or escapes the
 * repository root is never resolved.
 *
 * Backslashes are normalised to `/` first: a header-name is not a string literal, `\` is
 * an implementation-defined separator ([lex.header]/2), and MSVC accepts both.
 *
 * `exists(repoRelPosix)` reports whether a candidate file exists in the resolution universe
 * (disk at check time; a fixed known-set in unit tests). PURE except through its arguments.
 */
export interface IncludeRoots {
  /**
   * The include roots a compilation database gives `fromFile` (repo-relative POSIX dirs,
   * '' = repository root), or undefined when there is no usable database. `quote` holds the
   * `-iquote` roots (searched for quoted includes only), `angle` the `-I` roots (searched
   * for both forms).
   */
  compileDbRoots(fromFile: string): { quote: readonly string[]; angle: readonly string[] } | undefined;
  /** The probe roots used when there is no database: '' and every `include` directory. */
  probeRoots(): readonly string[];
  /** Optional: true when the graph excludes this repo-relative POSIX path. */
  isExcluded?(repoRelPosix: string): boolean;
}

export function resolveIncludePath(
  specifier: string,
  fromFile: string,
  exists: (repoRelPosix: string) => boolean,
  roots?: IncludeRoots,
): string | undefined {
  const angle = specifier.length >= 2 && specifier.startsWith('<') && specifier.endsWith('>');
  const name = toPosix(angle ? specifier.slice(1, -1) : specifier).trim();
  if (name === '' || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return undefined;

  // 1. Quoted: the includer's own directory first — the compiler takes this hit before any
  //    root, so it is never subject to the ambiguity rule.
  if (!angle) {
    const fromDir = path.posix.dirname(toPosix(fromFile));
    const relative = normalizeRepoRel(path.posix.join(fromDir, name));
    if (relative !== undefined && exists(relative)) return relative;
  }
  if (roots === undefined) return undefined;

  // 2. Include roots: the compilation database when there is one, else the probe.
  let candidates: readonly string[];
  const db = roots.compileDbRoots(fromFile);
  if (db !== undefined) {
    candidates = angle ? db.angle : [...db.quote, ...db.angle];
  } else {
    if (angle || !isProbeable(name)) return undefined;
    candidates = roots.probeRoots();
  }
  const hits = new Set<string>();
  for (const root of candidates) {
    const candidate = normalizeRepoRel(root === '' ? name : path.posix.join(root, name));
    if (candidate === undefined || !exists(candidate)) continue;
    if (roots.isExcluded?.(candidate) === true) continue;
    hits.add(candidate);
  }
  if (hits.size !== 1) return undefined; // none, or ambiguous → silence
  return [...hits][0];
}

/** A quoted name the no-database probe may look up: 2+ segments, none of them `.`/`..`. */
function isProbeable(name: string): boolean {
  const segs = name.split('/');
  if (segs.length < 2) return false;
  return segs.every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * Parse a `compile_commands.json` (the JSON Compilation Database) into per-translation-unit
 * include roots. `dbDirAbs` is the absolute directory holding the database, `projectRoot` the
 * absolute repository root. Each entry's `directory` (absolute, or — leniently — relative to
 * the database's directory) anchors its `file` and its include flags. Recognised flags:
 * `-I<dir>`, `-I <dir>`, `--include-directory=<dir>`, `-iquote<dir>`, `-iquote <dir>`, and
 * for a `cl`/`clang-cl` driver `/I<dir>`, `/I <dir>`. `-isystem` and `-idirafter` are
 * deliberately ignored (system roots). Roots and files outside the repository are dropped.
 *
 * Returns undefined when the text is not a database or no entry names a file inside the
 * repository — the caller then behaves as though there were no database.
 */
export function parseCompileCommands(
  text: string,
  dbDirAbs: string,
  projectRoot: string,
): CompileDb | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const byFile = new Map<string, { quote: string[]; angle: string[] }>();
  const allQuote: string[] = [];
  const allAngle: string[] = [];
  const toRepoRel = (abs: string): string | undefined => {
    const rel = path.relative(projectRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    const posix = toPosix(rel);
    return posix === '.' ? '' : posix;
  };
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.directory !== 'string' || typeof e.file !== 'string') continue;
    const dirAbs = path.resolve(dbDirAbs, e.directory);
    const fileRel = toRepoRel(path.resolve(dirAbs, e.file));
    if (fileRel === undefined || fileRel === '') continue;
    let args: string[];
    if (Array.isArray(e.arguments)) args = e.arguments.filter((a): a is string => typeof a === 'string');
    else if (typeof e.command === 'string') args = splitCommand(e.command);
    else continue;
    const msvc = args.length > 0 && /(^|[\\/])(clang-)?cl(\.exe)?$/i.test(args[0]);
    const roots = { quote: [] as string[], angle: [] as string[] };
    const add = (list: string[], dir: string): void => {
      const rel = toRepoRel(path.resolve(dirAbs, dir));
      if (rel === undefined) return;
      if (!list.includes(rel)) list.push(rel);
    };
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '-I' || (msvc && a === '/I')) { if (i + 1 < args.length) add(roots.angle, args[++i]); continue; }
      if (a === '-iquote') { if (i + 1 < args.length) add(roots.quote, args[++i]); continue; }
      if (a === '-isystem' || a === '-idirafter' || a === '--include-directory') {
        if (a === '--include-directory' && i + 1 < args.length) add(roots.angle, args[i + 1]);
        i++;
        continue;
      }
      if (a.startsWith('--include-directory=')) { add(roots.angle, a.slice('--include-directory='.length)); continue; }
      if (a.startsWith('-iquote')) { add(roots.quote, a.slice('-iquote'.length)); continue; }
      if (a.startsWith('-I')) { add(roots.angle, a.slice(2)); continue; }
      if (msvc && a.startsWith('/I')) { add(roots.angle, a.slice(2)); continue; }
    }
    const existing = byFile.get(fileRel);
    if (existing === undefined) byFile.set(fileRel, roots);
    else {
      for (const q of roots.quote) if (!existing.quote.includes(q)) existing.quote.push(q);
      for (const q of roots.angle) if (!existing.angle.includes(q)) existing.angle.push(q);
    }
    for (const q of roots.quote) if (!allQuote.includes(q)) allQuote.push(q);
    for (const q of roots.angle) if (!allAngle.includes(q)) allAngle.push(q);
  }
  if (byFile.size === 0) return undefined;
  return {
    rootsFor(fromFile: string) {
      return byFile.get(toPosix(fromFile)) ?? { quote: allQuote, angle: allAngle };
    },
  };
}

/** A parsed compilation database: the include roots of a file (its own entry's, or the
 *  union of every entry's when the file is not a translation unit of the database). */
export interface CompileDb {
  rootsFor(fromFile: string): { quote: readonly string[]; angle: readonly string[] };
}

/** Split a shell command line into arguments: whitespace-separated, with '…' and "…"
 *  quoting and backslash escapes outside single quotes. Enough for the flags read here. */
function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inArg = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; inArg = true; continue; }
    if (c === '\\' && i + 1 < command.length) { cur += command[++i]; inArg = true; continue; }
    if (/\s/.test(c)) {
      if (inArg) { out.push(cur); cur = ''; inArg = false; }
      continue;
    }
    cur += c;
    inArg = true;
  }
  if (inArg) out.push(cur);
  return out;
}

/** Normalize a repo-relative POSIX path; reject any that escapes the repo root. */
function normalizeRepoRel(p: string): string | undefined {
  const norm = path.posix.normalize(p);
  if (norm === '..' || norm.startsWith('../') || norm.startsWith('/')) return undefined;
  return norm;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
