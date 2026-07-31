import path from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolveTsPath } from './extractors/typescript-resolve.js';
import { resolvePythonModule } from './extractors/python-resolve.js';
import { resolveGoImport, type GoResolveDeps } from './extractors/go-resolve.js';
import { resolveJavaFqn, resolveJavaPackageFiles, type JavaResolveDeps } from './extractors/java-resolve.js';
import { resolvePhpFqn, parsePsr4, type PhpResolveDeps } from './extractors/php-resolve.js';
import { resolveRustPath, type RustResolveDeps } from './extractors/rust-resolve.js';
import { resolveIncludePath } from './extractors/include-resolve.js';
import { resolveRubyRequireRelative } from './extractors/ruby-resolve.js';
import { buildOwnerIndex } from './owner-index.js';
import { resolveGraphExclusionSet, isExcludedFromGraph, NO_COVERAGE_EXCLUDED } from '../io/repo-scanner.js';
import type { Graph } from '../model/graph.js';

/** Production resolvePathToFile: dispatches by language to the per-language path resolver.
 *  Checks existence against the project's files on disk. Symbol-resolved languages (and
 *  not-yet-implemented ones) return undefined here — they resolve via the SymbolTable.
 *
 *  `ownerOf` and `isExcluded`, when supplied, feed the Go/Java package resolvers below so
 *  they can pick a package directory's REPRESENTATIVE file. They play DIFFERENT roles and
 *  must never be conflated:
 *    - `ownerOf` MUST be the RAW, exclusion-BLIND owner index — it decides whether a
 *      package is genuinely split across two graph owners, and that decision has to see
 *      every file the owners actually map, excluded or not. Guarding it here would let
 *      excluding one member of a split package collapse the split into a false single
 *      owner and FABRICATE an edge the code does not have — the opposite failure from the
 *      one this module exists to prevent.
 *    - `isExcluded`, when supplied, is consulted ONLY to skip an excluded file when
 *      picking which of an already-resolved sole owner's files represents the package.
 *  A caller resolving a specifier fresh from source — the specifier can name any file on
 *  disk, excluded or not — must build this through {@link guardedResolve} instead of
 *  calling this directly with a raw `ownerOf` and no `isExcluded`: without `isExcluded`,
 *  the chosen representative can be an EXCLUDED file, and the resolver's own downstream
 *  `ownerIndex.ownerOf` step then answers "no owner" for it, silencing the whole edge —
 *  including the part of it justified by the package's other, non-excluded, fully
 *  enforced files. */
export function makeResolvePathToFile(
  projectRoot: string,
  ownerOf?: (repoRelPosix: string) => string | undefined,
  isExcluded?: (repoRelPosix: string) => boolean,
): (specifier: string, fromFile: string, language: string, isPackage?: boolean) => string | undefined {
  const exists = (repoRelPosix: string): boolean => existsSync(path.resolve(projectRoot, repoRelPosix));
  const goDeps = makeGoResolveDeps(projectRoot, ownerOf, isExcluded);
  const javaDeps = makeJavaResolveDeps(projectRoot, exists);
  const phpDeps = makePhpResolveDeps(projectRoot, exists);
  const rustDeps = makeRustResolveDeps(projectRoot);
  return (specifier, fromFile, language, isPackage = false) => {
    if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
      return resolveTsPath(specifier, fromFile, exists);
    }
    if (language === 'python') {
      return resolvePythonModule(specifier, fromFile, exists);
    }
    if (language === 'go') {
      return resolveGoImport(specifier, fromFile, goDeps);
    }
    if (language === 'java') {
      if (isPackage) {
        // Wildcard package import: collect RAW owners (exclusion-blind — see this
        // function's own doc comment above for why) of ALL .java in the resolved
        // package dir. Exactly one distinct owner → attribute a NON-EXCLUDED file
        // that owner maps, falling back to its first file only when every one of
        // its files is excluded (the downstream guarded owner lookup then silences
        // it honestly, same as a wholly-excluded package); zero or 2+ distinct
        // owners → silence (never guess across a split, and never let an exclusion
        // turn a real split into a false single owner).
        const files = resolveJavaPackageFiles(specifier, fromFile, javaDeps);
        let sole: string | undefined;
        for (const f of files) {
          const owner = ownerOf?.(f);
          if (owner === undefined) continue; // unmapped file is not part of the owner set
          if (sole === undefined) {
            sole = owner;
          } else if (owner !== sole) {
            return undefined; // 2+ distinct owners → split package → silence
          }
        }
        if (sole === undefined) return undefined;
        const soleOwned = files.filter((f) => ownerOf?.(f) === sole);
        return soleOwned.find((f) => !(isExcluded?.(f) ?? false)) ?? soleOwned[0];
      }
      return resolveJavaFqn(specifier, fromFile, javaDeps);
    }
    if (language === 'php') {
      return resolvePhpFqn(specifier, fromFile, phpDeps);
    }
    if (language === 'rust') {
      return resolveRustPath(specifier, fromFile, exists, rustDeps);
    }
    if (language === 'c' || language === 'cpp') {
      // C and C++ share ONE include resolver: a quoted `#include "header"` resolves
      // relative to the including file, then against common include roots. The header's
      // owning node is the dependency target (header/impl share a node).
      return resolveIncludePath(specifier, fromFile, exists);
    }
    if (language === 'ruby') {
      // Ruby's ONLY path-precise link: `require_relative '<lit>'` resolves relative to the
      // requiring file's directory (`.rb` appended). Constant references carry no path —
      // they route through the SymbolTable, so they never reach this branch.
      return resolveRubyRequireRelative(specifier, fromFile, exists);
    }
    return undefined;
  };
}

/**
 * Build the production `resolvePathToFile` against the SAME exclusion set (the
 * nested-project boundary plus the adopter's own `coverage.excluded` roots)
 * `runRelationPass`'s own file enumeration and ownership re-pointing already honor.
 * Every caller that resolves an import/reference specifier fresh from source — `yg
 * check`'s live relation gate (including its hidden `--attention-dump` diagnostic) and
 * the portal's boundary computation (which backs `yg structure`'s navigation and `yg
 * advise`'s detected-edge signal) — must build `resolvePathToFile` through this
 * constructor rather than calling `makeResolvePathToFile` with a raw owner index and no
 * exclusion awareness. `yg find` never resolves an import specifier at all (it searches
 * graph documents, not code edges), so it is not among these callers.
 *
 * Passes the owner index in its two distinct roles `makeResolvePathToFile`'s own doc
 * comment describes: the RAW (exclusion-blind) index for split-package detection, and a
 * same-set `isExcluded` predicate for representative-file picking — never the same
 * guarded index for both, which would let an exclusion collapse a genuinely split
 * package into a false single owner and fabricate an edge instead of merely silencing
 * one.
 */
export async function guardedResolve(
  projectRoot: string,
  graph: Graph,
): Promise<(specifier: string, fromFile: string, language: string, isPackage?: boolean) => string | undefined> {
  const coverage = graph.config.coverage ?? NO_COVERAGE_EXCLUDED;
  const exclusion = await resolveGraphExclusionSet(projectRoot, coverage);
  const rawOwnerOf = buildOwnerIndex(graph.nodes).ownerOf;
  const isExcluded = (repoRelPosix: string): boolean => isExcludedFromGraph(repoRelPosix, exclusion);
  return makeResolvePathToFile(projectRoot, rawOwnerOf, isExcluded);
}

/**
 * Build the disk-backed Rust resolution capabilities for a project root. A Rust path
 * (`crate::a::b`) resolves through the crate's module tree rooted at the crate's
 * `src/` directory. The crate root is the nearest ancestor of the importing file that
 * contains a `Cargo.toml`; its `src/` is the module-tree root, and `[package].name`
 * (hyphens → underscores) is the crate's own name so a path rooted at that name is
 * treated like `crate`. The discovery is CACHED per Cargo.toml directory — Cargo.toml
 * is stable across a single factory instance, so each manifest is read at most once.
 *
 * No Cargo.toml ancestor → undefined crate root, which the resolver treats as silence
 * (it never guesses a source root).
 *
 * NOTE: makeResolvePathToFile's deps are pure filesystem access;
 * reading Cargo.toml there is fine — it reads a file, it does not parse source.
 */
function makeRustResolveDeps(projectRoot: string): RustResolveDeps {
  // Cache: Cargo.toml directory (repo-rel POSIX, '' = root) → { srcDir, crateName }.
  const byDir = new Map<string, { srcDir: string; crateName: string | undefined } | undefined>();

  /** Read `[package].name` from a Cargo.toml at the given repo-rel dir, or undefined.
   *  A minimal TOML scan: find the `[package]` section, then the first `name = "..."`
   *  before the next `[section]`. Hyphens in the package name map to underscores (the
   *  crate identifier rule). */
  function readCrateName(repoRelDir: string): string | undefined {
    const abs = path.join(projectRoot, repoRelDir, 'Cargo.toml');
    let text: string;
    try {
      text = readFileSync(abs, 'utf-8');
    } catch {
      return undefined;
    }
    let inPackage = false;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('[')) {
        inPackage = line === '[package]';
        continue;
      }
      if (!inPackage) continue;
      const m = line.match(/^name\s*=\s*["']([^"']+)["']/);
      if (m) return m[1].replace(/-/g, '_');
    }
    return undefined;
  }

  /** Find the nearest ancestor directory of `fromFile` that contains a Cargo.toml,
   *  then return its `src/` directory and crate name. Walks up to (and including) the
   *  project root. */
  function crateRootFor(
    fromFile: string,
  ): { srcDir: string; crateName: string | undefined } | undefined {
    let dir = path.posix.dirname(toPosix(fromFile));
    if (dir === '.') dir = '';
    for (;;) {
      if (byDir.has(dir)) {
        const cached = byDir.get(dir);
        if (cached !== undefined) return cached;
      } else if (existsSync(path.join(projectRoot, dir, 'Cargo.toml'))) {
        const srcDir = dir === '' ? 'src' : path.posix.join(dir, 'src');
        const entry = { srcDir, crateName: readCrateName(dir) };
        byDir.set(dir, entry);
        return entry;
      } else {
        byDir.set(dir, undefined);
      }
      if (dir === '') return undefined; // reached the root without a Cargo.toml
      const parent = path.posix.dirname(dir);
      dir = parent === '.' ? '' : parent;
    }
  }

  return { crateRootFor };
}

/**
 * Build the disk-backed Go resolution capabilities for a project root. The module
 * path (the `module <path>` line of go.mod) is read from the nearest go.mod ancestor
 * of the importing file and CACHED per go.mod directory — go.mod is stable across a
 * single factory instance, so each module root is read at most once. Listing the
 * package directory (readdirSync) is the only per-import disk touch.
 *
 * NOTE: makeResolvePathToFile's deps are pure filesystem access;
 * reading go.mod + readdirSync is fine there — it lists/reads files, it does not parse.
 */
function makeGoResolveDeps(
  projectRoot: string,
  ownerOf?: (repoRelPosix: string) => string | undefined,
  isExcluded?: (repoRelPosix: string) => boolean,
): GoResolveDeps {
  // Cache: go.mod directory (repo-rel POSIX, '' = root) → module path or undefined.
  const moduleByDir = new Map<string, string | undefined>();

  /** Read the `module <path>` declaration from a go.mod at the given repo-rel dir, or undefined. */
  function readModulePath(repoRelDir: string): string | undefined {
    const abs = path.join(projectRoot, repoRelDir, 'go.mod');
    let text: string;
    try {
      text = readFileSync(abs, 'utf-8');
    } catch {
      return undefined;
    }
    // First non-comment `module <path>` line wins. go.mod is line-oriented; the
    // module directive is mandatory and appears once.
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('//')) continue;
      const m = line.match(/^module\s+(\S+)/);
      if (m) return m[1];
    }
    return undefined;
  }

  /** Find the nearest ancestor directory of `fromFile` that contains a go.mod, then
   *  return its module path AND that directory. The directory (repo-rel POSIX, '' =
   *  root) is the go.mod-bearing module root — required so a NESTED submodule's
   *  packages root under the submodule dir, not the repo root. `moduleByDir` is keyed
   *  by the go.mod directory and stores the module path declared by the go.mod IN
   *  that exact dir, so the `dir` at the point of return IS that module's directory.
   *  Walks up to (and including) the project root. */
  function modulePathFor(
    fromFile: string,
  ): { modulePath: string; moduleDir: string } | undefined {
    let dir = path.posix.dirname(toPosix(fromFile));
    if (dir === '.') dir = '';
    for (;;) {
      if (moduleByDir.has(dir)) {
        const cached = moduleByDir.get(dir);
        if (cached !== undefined) return { modulePath: cached, moduleDir: dir };
      } else {
        const mod = existsSync(path.join(projectRoot, dir, 'go.mod'))
          ? readModulePath(dir)
          : undefined;
        moduleByDir.set(dir, mod);
        if (mod !== undefined) return { modulePath: mod, moduleDir: dir };
      }
      if (dir === '') return undefined; // reached the root without a usable go.mod
      const parent = path.posix.dirname(dir);
      dir = parent === '.' ? '' : parent;
    }
  }

  function dirExists(repoRelDir: string): boolean {
    const abs = path.resolve(projectRoot, repoRelDir);
    try {
      return statSync(abs).isDirectory();
    } catch {
      return false;
    }
  }

  function goFilesIn(repoRelDir: string): string[] {
    const abs = path.resolve(projectRoot, repoRelDir);
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.go')) {
        out.push(repoRelDir === '' ? e.name : path.posix.join(repoRelDir, e.name));
      }
    }
    return out;
  }

  return { modulePathFor, dirExists, goFilesIn, ownerOf, isExcluded };
}

/**
 * Build the disk-backed Java resolution capabilities for a project root. Java
 * resolution is pure file/directory existence (the package = directory convention),
 * so `exists` is shared with the other resolvers; the only extra capability is
 * listing a package directory's `.java` files for a wildcard import.
 *
 * NOTE: makeResolvePathToFile's deps are pure filesystem access;
 * readdirSync is fine there — it lists files, it does not parse.
 */
function makeJavaResolveDeps(
  projectRoot: string,
  exists: (repoRelPosix: string) => boolean,
): JavaResolveDeps {
  function javaFilesIn(repoRelDir: string): string[] {
    const abs = path.resolve(projectRoot, repoRelDir);
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.java')) {
        out.push(repoRelDir === '' ? e.name : path.posix.join(repoRelDir, e.name));
      }
    }
    return out;
  }
  return { exists, javaFilesIn };
}

/**
 * Build the disk-backed PHP resolution capabilities for a project root. PHP maps a
 * class FQN to a file through composer's PSR-4 autoloading, so the only extra
 * capability beyond `exists` is producing the PSR-4 prefix→directory map in effect for
 * an importing file. That map comes from the NEAREST ancestor composer.json (a monorepo
 * may have several); its `autoload.psr-4` / `autoload-dev.psr-4` are parsed once per
 * composer.json directory and CACHED — composer.json is stable across a single factory
 * instance, so each is read at most once.
 *
 * No composer.json found (or an unreadable / classmap-only one) yields an empty map,
 * which the resolver treats as silence — it never guesses a source root.
 *
 * NOTE: makeResolvePathToFile's deps are pure filesystem access;
 * reading composer.json there is fine — it reads a file, it does not parse source.
 */
function makePhpResolveDeps(
  projectRoot: string,
  exists: (repoRelPosix: string) => boolean,
): PhpResolveDeps {
  // Cache: composer.json directory (repo-rel POSIX, '' = root) → parsed PSR-4 map.
  const psr4ByDir = new Map<string, Map<string, string[]>>();

  /** Parse the PSR-4 map from a composer.json at the given repo-rel dir, or empty. */
  function readPsr4(repoRelDir: string): Map<string, string[]> {
    const abs = path.join(projectRoot, repoRelDir, 'composer.json');
    let text: string;
    try {
      text = readFileSync(abs, 'utf-8');
    } catch {
      return new Map();
    }
    return parsePsr4(text, repoRelDir);
  }

  /** Find the nearest ancestor directory of `fromFile` that has a composer.json, then
   *  return its parsed PSR-4 map. Walks up to (and including) the project root. The
   *  FIRST composer.json found wins — nested packages own their files. */
  function psr4For(fromFile: string): ReadonlyMap<string, readonly string[]> {
    let dir = path.posix.dirname(toPosix(fromFile));
    if (dir === '.') dir = '';
    for (;;) {
      if (psr4ByDir.has(dir)) {
        const cached = psr4ByDir.get(dir);
        if (cached !== undefined && cached.size > 0) return cached;
      } else if (existsSync(path.join(projectRoot, dir, 'composer.json'))) {
        const map = readPsr4(dir);
        psr4ByDir.set(dir, map);
        if (map.size > 0) return map;
      } else {
        psr4ByDir.set(dir, new Map());
      }
      if (dir === '') return new Map(); // reached the root without a usable composer.json
      const parent = path.posix.dirname(dir);
      dir = parent === '.' ? '' : parent;
    }
  }

  return { psr4For, exists };
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
