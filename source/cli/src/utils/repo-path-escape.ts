/**
 * source/cli/src/utils/repo-path-escape.ts — the one containment check for a
 * path an authored file names relative to a root (a node mapping entry, an
 * aspect reference or companion, a marketplace package path, a packages-lock
 * file record).
 *
 * Security-relevant: every parser that accepts such a path asks this function
 * before the path is ever joined to a root, so a mapping, a reference and a
 * package record reject exactly the same escapes. One copy, so the three
 * parsers cannot drift apart.
 */

/**
 * True when `p` would escape the root it is read relative to: an absolute
 * path (`/…`), a Windows drive letter (`C:…`), a home-relative `~`, or a
 * `..` sequence that climbs above depth 0. An in-root `..` that never goes
 * negative (`a/../b`) is tolerated.
 *
 * Purely lexical: it reads the string only, never the file system, so a
 * symlink is not followed. Segments split on `/` alone — a backslash is an
 * ordinary character here — so a caller whose input may carry Windows
 * separators converts it with `toPosixPath` first.
 */
export function escapesRepo(p: string): boolean {
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:/.test(p)) return true;
  if (p.startsWith('~')) return true;
  let depth = 0;
  for (const segment of p.split('/')) {
    if (segment === '..') {
      depth--;
      if (depth < 0) return true;
    } else if (segment !== '' && segment !== '.') {
      depth++;
    }
  }
  return false;
}
