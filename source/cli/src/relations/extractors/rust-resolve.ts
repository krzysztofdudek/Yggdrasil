import path from 'node:path';

/**
 * Resolve a Rust `::`-path specifier to a repo-relative POSIX `.rs` source file, or
 * undefined.
 *
 * The specifier is what the extractor emits: a `::`-joined path rooted at `crate`,
 * `super`, `self`, or a bare crate-name segment (`crate::orders::Order`,
 * `super::util::X`, `self::y`, `std::collections::HashMap`).
 *
 * `exists(repoRelPosix)` reports whether a candidate file exists in the resolution
 * universe (disk at --approve time; a fixed known-set in unit tests). The crate root
 * is discovered through `crateRootFor` (resolve-path.ts), which walks up from the importing file to the
 * nearest `Cargo.toml` and returns that crate's `src/` directory (and, when known,
 * the crate's own package name so a path rooted at the crate's own name is treated
 * like `crate`).
 *
 * RESOLUTION MISS → undefined. This fail-to-silence is the single most important
 * false-positive guard:
 *   - A path rooted at an EXTERNAL crate (std, serde, tokio — any first segment that
 *     is NOT `crate`/`super`/`self` and NOT the current crate's own name) → undefined.
 *   - A mis-climbed `super::`, a path whose module file is not present, a
 *     macro-generated or build-script path → undefined.
 * Nothing outside the current crate's module tree is ever flagged.
 */
export interface RustResolveDeps {
  /**
   * For the importing file, find its crate's `src/` directory by walking up to the
   * nearest ancestor containing a `Cargo.toml`, then `<that-dir>/src`. Returns the
   * repo-relative POSIX `src` dir plus the crate's package name (from Cargo.toml
   * `[package].name`, hyphens normalized to underscores) when readable. Returns
   * undefined when no Cargo.toml ancestor is found.
   */
  crateRootFor(fromFile: string): { srcDir: string; crateName: string | undefined } | undefined;
}

export function resolveRustPath(
  specifier: string,
  fromFile: string,
  exists: (repoRelPosix: string) => boolean,
  deps: RustResolveDeps,
): string | undefined {
  const segments = specifier.split('::').filter((s) => s.length > 0);
  if (segments.length === 0) return undefined;

  const root = segments[0];
  const rest = segments.slice(1);
  const fromDir = path.posix.dirname(toPosix(fromFile));

  if (root === 'super' || root === 'self') {
    return resolveRelative(root, segments, fromFile, exists, deps);
  }

  const crate = deps.crateRootFor(fromFile);
  if (crate === undefined) return undefined; // no Cargo.toml ancestor → not a crate path

  if (root === 'crate') {
    return resolveFromModuleDir(crate.srcDir, rest, exists);
  }

  // A bare leading identifier: the current crate's own package name (2018+ edition
  // path-clarity) is treated like `crate`; any other name is an EXTERNAL crate.
  if (crate.crateName !== undefined && root === crate.crateName) {
    return resolveFromModuleDir(crate.srcDir, rest, exists);
  }

  // External crate (std/core/alloc, third-party) — not a graph-resolvable path.
  // `fromDir` is unused on this branch but kept above for relative resolution.
  void fromDir;
  return undefined;
}

/**
 * `super::…` / `self::…` — resolve relative to the importing file's MODULE.
 *
 * The importing file's module directory is the directory that would contain a child
 * module's file. For `src/a/b.rs` (module `crate::a::b`) the module's "own" directory
 * for `self::X` is `src/a/b/` (a submodule of b lives there) but b's items also live
 * in `b.rs` itself — so `self::X` probes both `src/a/b/X.rs`/`mod.rs` AND treats `X`
 * as an item of `b.rs`. For `src/a/mod.rs` (module `crate::a`) the module dir is
 * `src/a/`. `super::` climbs one module level: from `src/a/b.rs` (module `a::b`),
 * `super` is module `a`, whose dir is `src/a/` (and items live in `a.rs`/`a/mod.rs`).
 *
 * We model this as: derive the file's module DIRECTORY and its FILE-self candidates,
 * climb one directory level per leading `super`, then resolve the tail as a module
 * path under the resulting directory (with the longest-match item fallback).
 */
function resolveRelative(
  root: string,
  segments: string[],
  fromFile: string,
  exists: (repoRelPosix: string) => boolean,
  deps: RustResolveDeps,
): string | undefined {
  const crate = deps.crateRootFor(fromFile);
  if (crate === undefined) return undefined;
  const srcDir = crate.srcDir;

  const fromPosix = toPosix(fromFile);
  const fromDir = path.posix.dirname(fromPosix);
  const baseName = path.posix.basename(fromPosix, '.rs');

  // The module directory of the importing file: for `mod.rs`/`lib.rs`/`main.rs` it is
  // the file's own directory; for `foo.rs` it is `<dir>/foo` (the dir that would hold
  // foo's submodules). This is the directory `self::` resolves against.
  let moduleDir =
    baseName === 'mod' || baseName === 'lib' || baseName === 'main'
      ? fromDir
      : path.posix.join(fromDir, baseName);

  // Count leading super/self segments. `self` consumes one segment and stays; each
  // `super` consumes one segment and climbs one module level.
  let i = 0;
  for (; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === 'self') {
      // self only meaningfully appears first; treat as no climb.
      continue;
    }
    if (seg === 'super') {
      const parent = path.posix.dirname(moduleDir);
      if (!withinSrc(parent, srcDir)) return undefined; // climbed above the crate root
      moduleDir = parent;
      continue;
    }
    break;
  }
  // `root` is the first segment; the loop above already consumed it (self/super). The
  // remaining tail starts at i.
  void root;
  const tail = segments.slice(i);
  return resolveFromModuleDir(moduleDir, tail, exists);
}

/**
 * Resolve a module-relative tail (`['a','b','Sym']`) under a starting module
 * directory to a `.rs` file. Mirrors Rust's file layout with the longest-match
 * fallback for the case where the final segment(s) are ITEMS inside a module file
 * rather than submodules:
 *
 *   dir + a::b::Sym  → candidates, longest module-path first:
 *     <dir>/a/b/Sym.rs, <dir>/a/b/Sym/mod.rs        (Sym is a module)
 *     <dir>/a/b.rs,     <dir>/a/b/mod.rs            (Sym is an item in module a::b)
 *     <dir>/a.rs,       <dir>/a/mod.rs              (b::Sym are items in module a)
 *
 * Also the empty tail resolves to the module dir itself (`<dir>/mod.rs` is not used
 * here because `dir` already IS the module dir; the self/super caller handles that).
 * The FIRST existing candidate wins. Any miss → undefined (silence).
 */
function resolveFromModuleDir(
  moduleDir: string,
  tail: string[],
  exists: (repoRelPosix: string) => boolean,
): string | undefined {
  const segs = tail.filter((s) => s.length > 0);
  if (segs.length === 0) {
    // Path is just `crate`/`self`/the module itself → the module's own file.
    for (const cand of [joinUnder(moduleDir, 'mod.rs'), moduleDir + '.rs']) {
      if (cand !== undefined && exists(cand)) return cand;
    }
    return undefined;
  }

  // Try the longest module-path prefix first, shrinking the module part as the tail
  // segments are reinterpreted as items. For each prefix length k (segs[0..k] as a
  // module path), probe `<dir>/<seg0..segk>.rs` and `.../mod.rs`.
  for (let k = segs.length; k >= 1; k--) {
    const modulePart = segs.slice(0, k).join('/');
    const fileCand = joinUnder(moduleDir, modulePart + '.rs');
    const modCand = joinUnder(moduleDir, modulePart + '/mod.rs');
    if (fileCand !== undefined && exists(fileCand)) return fileCand;
    if (modCand !== undefined && exists(modCand)) return modCand;
  }
  // Final fallback: the ENTIRE tail is items inside THIS module — the owning file is
  // the module dir's own file (`<dir>.rs` or `<dir>/mod.rs`). This covers e.g.
  // `super::Type` resolving against module `crate::a` whose file is `src/a.rs`.
  for (const cand of [moduleDir + '.rs', joinUnder(moduleDir, 'mod.rs')]) {
    if (cand !== undefined && exists(cand)) return cand;
  }
  return undefined;
}

/** Is `dir` within (or equal to) the crate `src` root? Guards `super::` climbing
 *  above the crate root, which is an external/invalid path → silence. */
function withinSrc(dir: string, srcDir: string): boolean {
  const d = path.posix.normalize(dir);
  const s = path.posix.normalize(srcDir);
  if (s === '' || s === '.') return !d.startsWith('..');
  return d === s || d.startsWith(s + '/');
}

/** Join a repo-relative directory with a sub-path, normalizing; reject any path that
 *  escapes the repo root. '' → the sub-path itself. */
function joinUnder(dir: string, sub: string): string | undefined {
  const joined = path.posix.normalize(dir === '' ? sub : path.posix.join(dir, sub));
  if (joined.startsWith('..')) return undefined;
  return joined;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
