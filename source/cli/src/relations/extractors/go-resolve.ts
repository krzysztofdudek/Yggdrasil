import path from 'node:path';

/**
 * Resolve a Go import PATH to a repo-relative POSIX `.go` source file, or undefined.
 *
 * A Go import path (`example.com/mod/foo/bar`) names a package DIRECTORY, not a
 * single file. Mapping it to a graph node requires:
 *   (a) the module path from `go.mod` at the module root;
 *   (b) stripping that module prefix from the import path to get the repo-relative
 *       package DIRECTORY;
 *   (c) finding a representative `.go` file in that directory on disk;
 *   (d) handing that file to the owner index downstream.
 *
 * An import path that does NOT start with the module path (a stdlib package like
 * `fmt`/`os`, or an external module) resolves to NO mapped file → undefined. This
 * fail-to-silence is the single most important false-positive guard: only imports
 * under the repo's own module are graph-resolvable; everything else is silent.
 *
 * Dot-imports (`. "pkg"`) and blank imports (`_ "pkg"`) still name a real package
 * path, so the extractor emits the path normally and this resolver treats it like
 * any other — the local-binding form is irrelevant here.
 *
 * Resolution is pure except through `deps`, which provides disk access derived
 * from the project root. The module path is read from go.mod once and cached by
 * the caller (`makeGoResolveDeps` in resolve-path.ts).
 */
export interface GoResolveDeps {
  /**
   * The module path declared by the nearest `go.mod` for `fromFile` (the `module
   * <path>` line) together with the repo-relative POSIX DIRECTORY that go.mod sits
   * in, or undefined when no go.mod is found / readable. `moduleDir` is `''` when
   * the module is rooted at the repo root, and a non-empty repo-relative POSIX path
   * when the nearest go.mod is a NESTED SUBMODULE (e.g. `security/advancedtls`).
   *
   * Both halves are required to root a package: stripping `modulePath` from the
   * import path yields the package remainder RELATIVE TO THE MODULE, and that
   * remainder must be joined onto `moduleDir` (not the repo root) to get the real
   * on-disk package directory. Discarding `moduleDir` mis-roots every nested-submodule
   * import to the repo root — a confirmed false-positive source. Implementations
   * SHOULD cache this — it is stable for a given module root.
   */
  modulePathFor(fromFile: string): { modulePath: string; moduleDir: string } | undefined;
  /** Does a directory exist at this repo-relative POSIX path? */
  dirExists(repoRelDir: string): boolean;
  /** Repo-relative POSIX paths of `.go` files directly in this directory (no recursion). */
  goFilesIn(repoRelDir: string): string[];
  /**
   * Optional. Repo-relative POSIX file → owning node id, or undefined when no
   * node maps it. When supplied, resolveGoImport becomes OWNER-SET-AWARE: it
   * computes the owner of every production `.go` file the package directory
   * has left AFTER `isExcluded` below has removed any excluded one; all-one-owner
   * among what remains attributes that owner's representative file, 2+ distinct
   * owners among what remains silences the import entirely (package granularity —
   * a split package has no single graph owner, so attributing it to any one
   * file's owner would fabricate or hide a cross-node edge). Absent → today's
   * lexicographically-first pick, no owner check.
   *
   * Whether this is the raw index or one already guarded against an exclusion
   * set makes no difference here: every file this function queries it through
   * has already passed `isExcluded`, so a raw and a guarded index answer the
   * same thing for it either way.
   */
  ownerOf?(repoRelPosix: string): string | undefined;
  /**
   * Optional. True when the graph excludes this repo-relative POSIX path (a
   * nested project's own boundary, or a `coverage.excluded` root). An excluded
   * file is dropped from the package's candidate list BEFORE the owner-set
   * decision runs — the split-or-not question is answered from what remains,
   * never from the full, pre-exclusion file list. This is what keeps the
   * decision honest about every OTHER file in the package: an exclusion
   * removes its own file from consideration and nothing else. It can never
   * fabricate an owner a file never had (the owner set is still computed from
   * real mappings, just fewer files), and it can never bury a real dependency
   * reached through a file that is still there merely because some other,
   * now-excluded file used to make the package look split. When every file in
   * the package is excluded, nothing remains to decide from — the plain
   * lexicographically-first pick below hands that (excluded) file to the
   * caller's own, separately guarded owner lookup, which answers "no owner"
   * for it, the same silence a wholly-unmapped package already gets. Absent →
   * no file is ever dropped (today's behavior, unaffected).
   */
  isExcluded?(repoRelPosix: string): boolean;
}

export function resolveGoImport(
  importPath: string,
  fromFile: string,
  deps: GoResolveDeps,
): string | undefined {
  const resolved = deps.modulePathFor(fromFile);
  if (resolved === undefined) return undefined;
  const { modulePath, moduleDir } = resolved;
  if (modulePath === '') return undefined;

  // The import path must be the module path itself (module root package) or a
  // descendant of it (`<modulePath>/<dir>`). Anything else is stdlib/external → silence.
  // `remainder` is the package directory RELATIVE TO THE MODULE, not the repo root.
  let remainder: string;
  if (importPath === modulePath) {
    remainder = ''; // module root package
  } else if (importPath.startsWith(modulePath + '/')) {
    remainder = importPath.slice(modulePath.length + 1);
  } else {
    return undefined;
  }

  // Root the module-relative remainder under the go.mod DIRECTORY. For a root
  // module (`moduleDir === ''`) this is the remainder unchanged — identical to the
  // single-module behavior. For a NESTED submodule the package lives under the
  // submodule dir (e.g. `security/advancedtls` + `internal/testutils`), NOT at the
  // repo root. Joining here is what keeps a nested-submodule internal package from
  // colliding with a same-leaf directory at the repo root.
  const rel =
    remainder === ''
      ? moduleDir
      : moduleDir === ''
        ? remainder
        : path.posix.join(moduleDir, remainder);

  // Normalize to a repo-relative POSIX directory (defensive against stray slashes).
  const repoRelDir = path.posix.normalize(rel === '' ? '.' : rel);
  const cleanDir = repoRelDir === '.' ? '' : repoRelDir;

  if (!deps.dirExists(cleanDir)) return undefined;

  // Representative `.go` file in the package directory. Test files (`*_test.go`)
  // are excluded so the representative is a production source file; a directory
  // with ONLY test files falls back to one of those rather than missing a real
  // package.
  const goFiles = deps.goFilesIn(cleanDir);
  if (goFiles.length === 0) return undefined;
  const production = goFiles.filter((f) => !f.endsWith('_test.go'));
  const candidates = (production.length > 0 ? production : goFiles).sort();

  // Owner-set guard (package granularity), decided over the NON-EXCLUDED
  // candidates only. Drop any excluded file from the candidate list FIRST,
  // then ask whether what remains has one owner or several — a single
  // representative file cannot stand in for a package whose surviving files
  // belong to DIFFERENT graph nodes (a parent and child carving one
  // directory, or two siblings) without fabricating or hiding a cross-node
  // edge. Exactly one distinct owner among what remains → return a
  // (non-excluded, by construction) file that owner maps; 2+ distinct owners
  // among what remains → still split → silence (undefined). Files no node
  // maps do not contribute an owner (a wholly-unmapped package falls through
  // to the D7 unmapped-target silence downstream, unchanged). When nothing
  // remains (every candidate is excluded), the loop below never runs and
  // `sole` stays undefined, so control falls through to the plain
  // lexicographically-first pick at the end of this function — see
  // `isExcluded`'s own doc comment above for why that is still correct.
  if (deps.ownerOf) {
    const ownerOf = deps.ownerOf;
    const isExcluded = deps.isExcluded ?? ((): boolean => false);
    const remaining = candidates.filter((f) => !isExcluded(f));
    let sole: string | undefined; // the single distinct owner seen so far
    for (const f of remaining) {
      const o = ownerOf(f);
      if (o === undefined) continue; // unmapped file → no owner contribution
      if (sole === undefined) {
        sole = o;
      } else if (o !== sole) {
        return undefined; // 2+ distinct owners among what remains → split package → silence
      }
    }
    if (sole !== undefined) {
      const soleOwned = remaining.filter((f) => ownerOf(f) === sole);
      if (soleOwned.length > 0) return soleOwned[0];
    }
  }

  return candidates[0];
}
