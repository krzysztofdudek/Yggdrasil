import path from 'node:path';

/**
 * Resolve a Java import FQN to a repo-relative POSIX `.java` source file, or undefined.
 *
 * The specifier is what the extractor emits: a fully-qualified Java name. The
 * dispatch boundary (`makeResolvePathToFile`) routes the two universes:
 *   - TYPE FQN (`com.foo.Bar`, from a single-type or static import): routed through
 *     `resolveJavaFqn` — returns a single file, NO package fall-through.
 *   - PACKAGE FQN (`com.foo`, from a wildcard import, tagged `isPackage`): routed
 *     through `resolveJavaPackageFiles` — returns the candidate file LIST so the
 *     caller can apply owner-set collapse (one owner → attribute, 0/2+ → silence).
 *
 * Java compiles `package a.b.c; class Foo` to a path ending `a/b/c/Foo.java` under
 * SOME source root (commonly `src/main/java`, `src/test/java`, or a module srcDir;
 * flat layouts also exist). There is no single canonical root, so — exactly like
 * the Python module-path search — we probe the FQN as a file rooted at the importing
 * file's directory and at every ancestor directory up to (and including) the repo
 * root, nearest-first. The FIRST existing candidate wins.
 *
 * RESOLUTION MISS → undefined. This fail-to-silence is the single most important
 * false-positive guard: a `java.*` / `javax.*` / `jakarta.*` stdlib type, a
 * third-party library type, or any FQN whose file is not present resolves to
 * nothing and is never flagged.
 *
 * `deps.isExcluded`, when supplied, makes an excluded hit act as though it does
 * not exist, for BOTH resolvers: `resolveType` skips it and keeps walking (the
 * same candidate list at the current ancestor root, then further-out roots) and
 * `resolveJavaPackageFiles` skips it and, if that empties an ancestor root's
 * directory entirely, keeps climbing to the next one rather than stopping there.
 * A half-migrated or flat layout can leave the SAME FQN's file sitting under two
 * different ancestor roots — the nearer one always wins when live, but an
 * excluded nearer copy must not end the search: the farther, still-live copy is
 * the real target once the excluded one is set aside. Absent → no hit is ever
 * skipped (today's behavior, unaffected).
 */
export interface JavaResolveDeps {
  /** Does a file exist at this repo-relative POSIX path? */
  exists(repoRelPosix: string): boolean;
  /** Repo-relative POSIX paths of `.java` files directly in this directory (no recursion). */
  javaFilesIn(repoRelDir: string): string[];
  /**
   * Optional. True when the graph excludes this repo-relative POSIX path (a nested
   * project's own boundary, or a `coverage.excluded` root). See the file doc comment.
   */
  isExcluded?(repoRelPosix: string): boolean;
}

/**
 * Resolve a single-TYPE Java import FQN (`com.foo.Bar`) to a repo-relative `.java`
 * file, or undefined. NO package fall-through: a hint reaches here only for a TYPE
 * (the extractor tags package wildcards with `isPackage`, routed through
 * `resolveJavaPackageFiles` instead). A type FQN whose path is actually a package
 * DIRECTORY resolves to nothing — silence, not a phantom package edge.
 */
export function resolveJavaFqn(
  specifier: string,
  fromFile: string,
  deps: JavaResolveDeps,
): string | undefined {
  const segments = specifier.split('.').filter((s) => s.length > 0);
  if (segments.length === 0) return undefined;
  return resolveType(segments, fromFile, deps);
}

/**
 * Resolve a wildcard PACKAGE FQN (`com.foo`) to the candidate `.java` files in the
 * resolved package directory, found via the same ancestor-source-root search the type
 * resolver uses. Returns the LIVE (non-excluded) file list of the FIRST ancestor root
 * whose directory has at least one (caller computes the owner set over it: one owner →
 * attribute, zero or 2+ → silence). A root whose directory exists but whose every file
 * is excluded does NOT end the search — it is treated exactly like an empty directory,
 * so the walk keeps climbing to the next ancestor root instead of committing to a
 * directory this graph enforces nothing in. Empty list = the package directory (or a
 * live file in it) was found nowhere.
 */
export function resolveJavaPackageFiles(
  packageFqn: string,
  fromFile: string,
  deps: JavaResolveDeps,
): string[] {
  const segments = packageFqn.split('.').filter((s) => s.length > 0);
  if (segments.length === 0) return [];
  const pkgDir = segments.join('/'); // com/foo
  const isExcl = deps.isExcluded ?? ((): boolean => false);
  for (const dir of ancestorDirs(path.posix.dirname(toPosix(fromFile)))) {
    const repoRelDir = joinUnder(dir, pkgDir);
    const live = deps.javaFilesIn(repoRelDir).filter((f) => !isExcl(f));
    if (live.length > 0) return live.sort();
  }
  return [];
}

/** TYPE FQN `com.foo.Bar` → `com/foo/Bar.java` (with the nested-type parent fallback). */
function resolveType(
  segments: string[],
  fromFile: string,
  deps: JavaResolveDeps,
): string | undefined {
  const typePath = segments.join('/') + '.java'; // com/foo/Bar.java
  // Nested-type longest-match: drop the trailing segment (`Inner`) and try the
  // enclosing type's file (`com/foo/Outer.java`). Only when there is a segment to
  // drop beyond the bare class (>= 2 segments left after dropping).
  const parentTypePath =
    segments.length >= 2 ? segments.slice(0, -1).join('/') + '.java' : undefined;
  const isExcl = deps.isExcluded ?? ((): boolean => false);

  for (const dir of ancestorDirs(path.posix.dirname(toPosix(fromFile)))) {
    const candidates: string[] = [joinUnder(dir, typePath)];
    if (parentTypePath !== undefined) candidates.push(joinUnder(dir, parentTypePath));
    for (const cand of candidates) {
      // An excluded candidate is treated as though it does not exist: skip it and
      // keep walking (the rest of this root's candidates, then further-out roots)
      // rather than let it end the search the way a genuine miss never would.
      if (deps.exists(cand) && !isExcl(cand)) return cand;
    }
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
