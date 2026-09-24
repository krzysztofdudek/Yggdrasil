import path from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolveTsPath } from './extractors/typescript-resolve.js';
import { resolvePythonModule } from './extractors/python-resolve.js';
import { resolveGoImport, type GoResolveDeps } from './extractors/go-resolve.js';
import { resolveJavaFqn, resolveJavaPackageFiles, type JavaResolveDeps } from './extractors/java-resolve.js';
import { resolvePhpFqn, parsePsr4, type PhpResolveDeps } from './extractors/php-resolve.js';
import { resolveRustPath, type RustResolveDeps, type RustCrateRoot } from './extractors/rust-resolve.js';
import { resolveIncludePath } from './extractors/include-resolve.js';
import { resolveRubyRequireRelative } from './extractors/ruby-resolve.js';
import { buildOwnerIndex } from './owner-index.js';
import { resolveGraphExclusionSet, isExcludedFromGraph, NO_COVERAGE_EXCLUDED } from '../io/repo-scanner.js';
import type { Graph } from '../model/graph.js';

/** Production resolvePathToFile: dispatches by language to the per-language path resolver.
 *  Checks existence against the project's files on disk. Symbol-resolved languages (and
 *  not-yet-implemented ones) return undefined here — they resolve via the SymbolTable.
 *
 *  `ownerOf` and `isExcluded`, when supplied, feed every resolver below that can face
 *  MORE THAN ONE candidate file for a single specifier. Go and Java package imports use
 *  `isExcluded` to drop an excluded file from the package's candidate list BEFORE `ownerOf`
 *  is ever asked about it — the package's split-or-single-owner status is decided from what
 *  remains, not from every file the directory happens to hold. Python (multiple ancestor
 *  source roots matching the same dotted module) and PHP (multiple PSR-4 base directories
 *  for one prefix) face the same shape of ambiguity without an owner-set to collapse: their
 *  resolvers use `isExcluded` to drop an excluded match from the candidate SET before
 *  deciding whether resolution is ambiguous, so an excluded duplicate can no longer keep a
 *  real, surviving candidate silenced. Java's own ancestor-source-root search (both a precise
 *  type import and a wildcard package import) is nearest-first-wins rather than
 *  collect-then-decide, so it applies `isExcluded` differently: an excluded hit is treated as
 *  though it does not exist, so the walk keeps climbing to the next candidate — same root,
 *  then further-out roots — instead of letting an excluded nearer copy end the search before
 *  the farther, still-live copy is ever tried (see java-resolve.ts's own doc comment). Either
 *  way this is what keeps an exclusion honest about every OTHER file: excluding one file can
 *  only remove that file's own contribution to the decision — it can never fabricate an owner
 *  or a target a surviving file never had, and it can never bury a real dependency reached
 *  through a file that is still there. A caller resolving a specifier fresh from source — the
 *  specifier can name any file on disk, excluded or not — must build this through
 *  {@link guardedResolve} instead of calling this directly with `ownerOf` and no `isExcluded`:
 *  without `isExcluded`, an excluded file still counts toward the ambiguity decision (or, for
 *  Java, still wins the walk), which can silence a real cross-node dependency reached through
 *  the surviving, non-excluded, fully enforced candidate. */
export function makeResolvePathToFile(
  projectRoot: string,
  ownerOf?: (repoRelPosix: string) => string | undefined,
  isExcluded?: (repoRelPosix: string) => boolean,
): (specifier: string, fromFile: string, language: string, isPackage?: boolean) => string | undefined {
  const exists = (repoRelPosix: string): boolean => existsSync(path.resolve(projectRoot, repoRelPosix));
  const goDeps = makeGoResolveDeps(projectRoot, ownerOf, isExcluded);
  const javaDeps = makeJavaResolveDeps(projectRoot, exists, isExcluded);
  const phpDeps = makePhpResolveDeps(projectRoot, exists, isExcluded);
  const rustDeps = makeRustResolveDeps(projectRoot, exists);
  return (specifier, fromFile, language, isPackage = false) => {
    if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
      return resolveTsPath(specifier, fromFile, exists);
    }
    if (language === 'python') {
      return resolvePythonModule(specifier, fromFile, exists, isExcluded);
    }
    if (language === 'go') {
      return resolveGoImport(specifier, fromFile, goDeps);
    }
    if (language === 'java') {
      if (isPackage) {
        // Wildcard package import: `resolveJavaPackageFiles` already committed to the
        // first ANCESTOR ROOT with at least one LIVE (non-excluded) file — an
        // excluded-only root is skipped exactly like an empty one (see
        // java-resolve.ts's own doc comment) — so `files` here is already the live set
        // to decide ownership over. Exactly one distinct owner among them → attribute
        // one of its files; 2+ distinct owners → still split → silence.
        //
        // No `sole` owner found covers TWO different situations: `files` is empty (the
        // package was found nowhere live — `files[0]` is naturally `undefined`, the
        // same silence a wholly-unmapped package gets), or `files` is non-empty but no
        // node owns any of it (a package that is type-covered only, under
        // `coverage.type_level`, has no node owner for ANY file — the ordinary case,
        // not the exception). The fallback picks `files[0]` either way rather than
        // returning `undefined` outright: a caller that is not the node owner index
        // (the type-coverage lookup) still needs a live, non-excluded file to find the
        // package's matched type — silencing unconditionally here made every wildcard
        // import into a nodeless package invisible to that lookup, exclusion or not.
        const files = resolveJavaPackageFiles(specifier, fromFile, javaDeps);
        let sole: string | undefined;
        for (const f of files) {
          const owner = ownerOf?.(f);
          if (owner === undefined) continue; // unmapped file is not part of the owner set
          if (sole === undefined) {
            sole = owner;
          } else if (owner !== sole) {
            return undefined; // 2+ distinct owners among the live set → split package → silence
          }
        }
        if (sole === undefined) return files[0];
        const soleOwned = files.filter((f) => ownerOf?.(f) === sole);
        return soleOwned[0];
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
      // ONLY relative to the including file's own directory — deliberately no probe of
      // ancestor dirs or common include roots (see include-resolve.ts's own doc comment
      // for why: such a probe can only match a same-basename decoy the real compiler,
      // driven by -I flags this resolver cannot see, would never pick). The header's
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
 * Passes the owner index together with a same-set `isExcluded` predicate, exactly as
 * `makeResolvePathToFile`'s own doc comment describes: `isExcluded` drops an excluded
 * file from a package's candidate list before the owner index is ever asked about it,
 * so the split-or-single-owner decision is made from what remains — an exclusion can
 * remove its own file from consideration, never rewrite what is true of any other file.
 */
export async function guardedResolve(
  projectRoot: string,
  graph: Graph,
): Promise<(specifier: string, fromFile: string, language: string, isPackage?: boolean) => string | undefined> {
  const coverage = graph.config.coverage ?? NO_COVERAGE_EXCLUDED;
  const exclusion = await resolveGraphExclusionSet(projectRoot, coverage);
  const ownerOf = buildOwnerIndex(graph.nodes).ownerOf;
  const isExcluded = (repoRelPosix: string): boolean => isExcludedFromGraph(repoRelPosix, exclusion);
  return makeResolvePathToFile(projectRoot, ownerOf, isExcluded);
}

/**
 * Build the disk-backed Rust resolution capabilities for a project root. A Rust path
 * (`crate::a::b`) resolves through a crate's module tree. The PACKAGE is the nearest
 * ancestor of the importing file that contains a `Cargo.toml`; which CRATE of that package
 * the file belongs to follows Cargo's target auto-discovery (`src/lib.rs` / `src/main.rs`
 * for `src/**`, `src/bin/<x>.rs` and `src/bin/<x>/main.rs`, `tests/`, `examples/`,
 * `benches/`, `build.rs`) — see `rustTargetFor`. The package's crate name (`[lib].name`,
 * else `[package].name`, hyphens → underscores) addresses its library from any target.
 *
 * In-repo PATH DEPENDENCIES (`[dependencies]`, `[dev-dependencies]`,
 * `[build-dependencies]` and their `[target.*]` forms; inline `{ path = … }`, the
 * `[dependencies.<name>]` table form, and `{ workspace = true }` inherited from the nearest
 * `[workspace.dependencies]`) map the name code uses (`package =` renames honoured) to that
 * crate's library tree. A path that leaves the repository, or points at a directory with no
 * Cargo.toml, is ignored.
 *
 * Every manifest and crate-root file is read at most once per factory instance (cached) —
 * they are stable across one pass. No Cargo.toml ancestor → undefined crate root, which the
 * resolver treats as silence (it never guesses a source root).
 *
 * NOTE: makeResolvePathToFile's deps are pure filesystem access;
 * reading Cargo.toml / a crate-root file there is fine — it reads a file, it does not parse
 * source into a tree.
 */
function makeRustResolveDeps(
  projectRoot: string,
  exists: (repoRelPosix: string) => boolean,
): RustResolveDeps {
  // Cache: directory (repo-rel POSIX, '' = root) → the Cargo.toml read there (null = none).
  const manifestByDir = new Map<string, CargoManifest | null>();
  // Cache: directory → the nearest Cargo.toml directory at or above it (null = none).
  const packageDirByDir = new Map<string, string | null>();
  // Cache: crate-root file → its text with comments stripped ('' when unreadable).
  const rootTextByFile = new Map<string, string>();

  function manifestAt(dir: string): CargoManifest | undefined {
    if (!manifestByDir.has(dir)) {
      let text: string | undefined;
      try {
        text = readFileSync(path.join(projectRoot, dir, 'Cargo.toml'), 'utf-8');
      } catch {
        text = undefined;
      }
      manifestByDir.set(dir, text === undefined ? null : parseCargoManifest(text));
    }
    return manifestByDir.get(dir) ?? undefined;
  }

  /** The nearest directory at or above `dir` holding a Cargo.toml, or undefined. */
  function packageDirFrom(dir: string): string | undefined {
    const visited: string[] = [];
    let cur = dir;
    let found: string | null = null;
    for (;;) {
      const cached = packageDirByDir.get(cur);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      visited.push(cur);
      if (existsSync(path.join(projectRoot, cur, 'Cargo.toml'))) {
        found = cur;
        break;
      }
      if (cur === '') break;
      const parent = path.posix.dirname(cur);
      cur = parent === '.' ? '' : parent;
    }
    for (const v of visited) packageDirByDir.set(v, found);
    return found ?? undefined;
  }

  function dirOf(file: string): string {
    const d = path.posix.dirname(toPosix(file));
    return d === '.' ? '' : d;
  }

  function under(dir: string, sub: string): string | undefined {
    const joined = path.posix.normalize(dir === '' ? sub : path.posix.join(dir, sub));
    if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) return undefined;
    return joined === '.' ? '' : joined;
  }

  /** The library tree of the package at `pkgDir`. */
  function libTreeOf(pkgDir: string, manifest: CargoManifest | undefined): { srcDir: string; rootFiles: string[] } {
    const rootFile = under(pkgDir, manifest?.libPath ?? 'src/lib.rs') ?? under(pkgDir, 'src/lib.rs')!;
    return { srcDir: dirOf(rootFile), rootFiles: [rootFile] };
  }

  function crateRootFor(fromFile: string): RustCrateRoot | undefined {
    const file = toPosix(fromFile);
    const pkgDir = packageDirFrom(dirOf(file));
    if (pkgDir === undefined) return undefined;
    const manifest = manifestAt(pkgDir);
    const crateName = manifest?.crateName;
    const lib = libTreeOf(pkgDir, manifest);
    const rel = pkgDir === '' ? file : file.slice(pkgDir.length + 1);
    // Target sub-paths are package-relative and never climb, so a plain join is exact.
    const at = (sub: string): string => (pkgDir === '' || sub === '' ? pkgDir + sub : `${pkgDir}/${sub}`);
    const target = rustTargetFor(rel, (sub) => exists(at(sub)), manifest?.libPath);
    return {
      srcDir: at(target.srcDir),
      crateName,
      rootFiles: target.rootFiles.map(at),
      fileIsRoot: target.fileIsRoot,
      lib,
    };
  }

  function dependencyFor(fromFile: string, name: string): { srcDir: string; rootFiles: string[] } | undefined {
    const pkgDir = packageDirFrom(dirOf(toPosix(fromFile)));
    if (pkgDir === undefined) return undefined;
    const manifest = manifestAt(pkgDir);
    if (manifest === undefined) return undefined;
    for (const [key, spec] of manifest.dependencies) {
      let depDir: string | undefined;
      let rename = spec.package;
      if (spec.path !== undefined) {
        depDir = under(pkgDir, spec.path);
      } else if (spec.workspace) {
        // `{ workspace = true }` → the nearest ancestor manifest with a matching
        // `[workspace.dependencies]` entry; its path is relative to that manifest.
        let cur: string | undefined = pkgDir;
        while (cur !== undefined) {
          const ws = manifestAt(cur);
          const inherited = ws?.workspaceDependencies.get(key);
          if (inherited !== undefined) {
            if (inherited.path !== undefined) depDir = under(cur, inherited.path);
            rename = rename ?? inherited.package;
            break;
          }
          if (cur === '') break;
          const parent = path.posix.dirname(cur);
          cur = packageDirFrom(parent === '.' ? '' : parent);
        }
      }
      if (depDir === undefined) continue; // registry / git / out-of-repo → external
      const depManifest = manifestAt(depDir);
      if (depManifest === undefined) continue; // no Cargo.toml there → not a crate
      // The name code uses: the dependency key when renamed with `package =`, else the
      // target library's own crate name.
      const codeName = rename !== undefined ? normalizeCrateName(key) : (depManifest.crateName ?? normalizeCrateName(key));
      if (codeName !== name) continue;
      return libTreeOf(depDir, depManifest);
    }
    return undefined;
  }

  function rootDeclares(rootFile: string, name: string): boolean {
    let text = rootTextByFile.get(rootFile);
    if (text === undefined) {
      try {
        text = stripRustComments(readFileSync(path.join(projectRoot, rootFile), 'utf-8'));
      } catch {
        text = '';
      }
      rootTextByFile.set(rootFile, text);
    }
    return rustFileDeclares(text, name);
  }

  return { crateRootFor, dependencyFor, rootDeclares };
}

/** Which Cargo target a package-relative `.rs` path belongs to, following Cargo's target
 *  auto-discovery. `srcDir` is the target's module-tree root and `rootFiles` its crate-root
 *  files in probe order (both package-relative); `fileIsRoot` says whether `rel` IS the
 *  root. A shared helper under `tests/` (`tests/common/mod.rs`) belongs to whichever test
 *  crate declares it, so it gets the `tests/` tree with no root file to bind items to. */
export function rustTargetFor(
  rel: string,
  existsInPackage: (sub: string) => boolean,
  libPath?: string,
): { srcDir: string; rootFiles: string[]; fileIsRoot: boolean } {
  const segs = rel.split('/');
  if (segs[0] === 'src' && segs[1] === 'bin' && segs.length >= 3) {
    if (segs.length === 3) return { srcDir: 'src/bin', rootFiles: [rel], fileIsRoot: true };
    const dir = `src/bin/${segs[2]}`;
    const main = `${dir}/main.rs`;
    return { srcDir: dir, rootFiles: [main], fileIsRoot: rel === main };
  }
  if ((segs[0] === 'tests' || segs[0] === 'examples' || segs[0] === 'benches') && segs.length >= 2) {
    if (segs.length === 2) return { srcDir: segs[0], rootFiles: [rel], fileIsRoot: true };
    const dir = `${segs[0]}/${segs[1]}`;
    const main = `${dir}/main.rs`;
    if (existsInPackage(main)) return { srcDir: dir, rootFiles: [main], fileIsRoot: rel === main };
    return { srcDir: segs[0], rootFiles: [], fileIsRoot: false };
  }
  if (rel === 'build.rs') return { srcDir: '', rootFiles: [rel], fileIsRoot: true };
  const libRoot = path.posix.normalize(libPath ?? 'src/lib.rs');
  const mainRoot = 'src/main.rs';
  if (rel === libRoot || rel === mainRoot) return { srcDir: path.posix.dirname(rel), rootFiles: [rel], fileIsRoot: true };
  return { srcDir: 'src', rootFiles: [libRoot, mainRoot], fileIsRoot: false };
}

/** The parts of a Cargo.toml the Rust resolver needs. */
interface CargoDependencySpec {
  path?: string;
  package?: string;
  workspace: boolean;
}
interface CargoManifest {
  crateName: string | undefined;
  libPath: string | undefined;
  dependencies: Map<string, CargoDependencySpec>;
  workspaceDependencies: Map<string, CargoDependencySpec>;
}

function normalizeCrateName(name: string): string {
  return name.replace(/-/g, '_');
}

const DEP_TABLE = /^(?:target\..+\.)?(?:dependencies|dev-dependencies|dev_dependencies|build-dependencies|build_dependencies)$/;
const DEP_SUBTABLE = /^(?:target\..+\.)?(?:dependencies|dev-dependencies|dev_dependencies|build-dependencies|build_dependencies)\.(.+)$/;

/** A minimal, line-oriented Cargo.toml reader: `[package].name`, `[lib].name` / `.path`,
 *  and the path / package / workspace fields of dependency entries (inline tables and the
 *  `[dependencies.<name>]` table form) plus `[workspace.dependencies]`. Anything it does
 *  not recognise is ignored, which can only lose an edge, never invent one. */
export function parseCargoManifest(text: string): CargoManifest {
  let packageName: string | undefined;
  let libName: string | undefined;
  let libPath: string | undefined;
  const dependencies = new Map<string, CargoDependencySpec>();
  const workspaceDependencies = new Map<string, CargoDependencySpec>();
  let section = '';
  let subtable: { into: Map<string, CargoDependencySpec>; key: string } | undefined;

  const unquote = (v: string): string => v.trim().replace(/^["']|["']$/g, '');
  const stringField = (body: string, field: string): string | undefined => {
    const m = new RegExp(`(?:^|[\\s,{])${field}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(body);
    return m ? (m[1] ?? m[2]) : undefined;
  };
  const specOf = (body: string): CargoDependencySpec => ({
    path: stringField(body, 'path'),
    package: stringField(body, 'package'),
    workspace: /(?:^|[\s,{])workspace\s*=\s*true\b/.test(body),
  });

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header) {
      section = header[1].split('.').map((p) => unquote(p)).join('.');
      subtable = undefined;
      const sub = DEP_SUBTABLE.exec(section);
      const wsSub = /^workspace\.dependencies\.(.+)$/.exec(section);
      if (wsSub) subtable = { into: workspaceDependencies, key: unquote(wsSub[1]) };
      else if (sub) subtable = { into: dependencies, key: unquote(sub[1]) };
      if (subtable && !subtable.into.has(subtable.key)) subtable.into.set(subtable.key, { workspace: false });
      continue;
    }
    const kv = /^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = unquote(kv[1]);
    const value = kv[2].trim();
    if (subtable) {
      const spec = subtable.into.get(subtable.key)!;
      if (key === 'path') spec.path = unquote(value);
      else if (key === 'package') spec.package = unquote(value);
      else if (key === 'workspace') spec.workspace = value === 'true';
      continue;
    }
    if (section === 'package' && key === 'name') packageName = unquote(value);
    else if (section === 'lib' && key === 'name') libName = unquote(value);
    else if (section === 'lib' && key === 'path') libPath = unquote(value);
    else if (DEP_TABLE.test(section) || section === 'workspace.dependencies') {
      const into = section === 'workspace.dependencies' ? workspaceDependencies : dependencies;
      if (!into.has(key)) into.set(key, value.startsWith('{') ? specOf(value) : { workspace: false });
    }
  }
  const name = libName ?? packageName;
  return {
    crateName: name === undefined ? undefined : normalizeCrateName(name),
    libPath,
    dependencies,
    workspaceDependencies,
  };
}

/** Rust source with `//` line comments and `/* … *\/` block comments blanked (string
 *  contents are not special-cased: a stray match can only fail to find a name, or find one
 *  a comment-like string mentions — both keep the lookup conservative enough for a root
 *  file's own declarations). */
function stripRustComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Does Rust source `text` declare an item called `name` (struct / enum / union / trait /
 *  type / fn / const / static / mod / macro_rules!) or bring it into scope with a `use`? */
export function rustFileDeclares(text: string, name: string): boolean {
  const id = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const decl = new RegExp(
    `\\b(?:struct|enum|union|trait|type|fn|const|static|mod)\\s+(?:r#)?${id}\\b|\\bmacro_rules!\\s*(?:r#)?${id}\\b`,
  );
  if (decl.test(text)) return true;
  const word = new RegExp(`(?:^|[^A-Za-z0-9_#])(?:r#)?${id}(?![A-Za-z0-9_])`);
  for (const m of text.matchAll(/\buse\s+[^;]*;/g)) {
    if (word.test(m[0])) return true;
  }
  return false;
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
    return parseGoModulePath(text);
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

  /** The module path of a go.mod directly in `dir`, or undefined (cached with the walk). */
  function moduleAt(dir: string): string | undefined {
    if (!moduleByDir.has(dir)) {
      moduleByDir.set(dir, existsSync(path.join(projectRoot, dir, 'go.mod')) ? readModulePath(dir) : undefined);
    }
    return moduleByDir.get(dir);
  }

  // Cache: directory → the `use` member directories of the nearest go.work at or above it.
  const workMembersByDir = new Map<string, string[]>();

  /** Member module directories (repo-rel POSIX) of the nearest go.work at or above `dir`. */
  function workMembersFrom(dir: string): string[] {
    const cached = workMembersByDir.get(dir);
    if (cached !== undefined) return cached;
    let members: string[] = [];
    const abs = path.join(projectRoot, dir, 'go.work');
    if (existsSync(abs)) {
      let text: string;
      try {
        text = readFileSync(abs, 'utf-8');
      } catch {
        text = '';
      }
      for (const use of parseGoWorkUses(text)) {
        const joined = path.posix.normalize(dir === '' ? use : path.posix.join(dir, use));
        if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) continue;
        members.push(joined === '.' ? '' : joined);
      }
    } else if (dir !== '') {
      const parent = path.posix.dirname(dir);
      members = workMembersFrom(parent === '.' ? '' : parent);
    }
    workMembersByDir.set(dir, members);
    return members;
  }

  /** Every in-repo module reachable from `fromFile`: each go.mod from the file's directory
   *  up to the root (nearest first), plus the members of the nearest go.work. */
  function modulesFor(fromFile: string): Array<{ modulePath: string; moduleDir: string }> {
    const out: Array<{ modulePath: string; moduleDir: string }> = [];
    let dir = path.posix.dirname(toPosix(fromFile));
    if (dir === '.') dir = '';
    const start = dir;
    for (;;) {
      const mod = moduleAt(dir);
      if (mod !== undefined) out.push({ modulePath: mod, moduleDir: dir });
      if (dir === '') break;
      const parent = path.posix.dirname(dir);
      dir = parent === '.' ? '' : parent;
    }
    for (const member of workMembersFrom(start)) {
      const mod = moduleAt(member);
      if (mod !== undefined && !out.some((m) => m.moduleDir === member)) {
        out.push({ modulePath: mod, moduleDir: member });
      }
    }
    return out;
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

  return { modulePathFor, modulesFor, moduleAt, dirExists, goFilesIn, ownerOf, isExcluded };
}

/** Strip a go.mod / go.work line comment and surrounding space. */
function goLine(raw: string): string {
  return raw.replace(/\/\/.*$/, '').trim();
}

/** Unquote a go.mod token: `"x"` (interpreted string) or a backtick raw string; a bare
 *  token is returned as is. */
function goUnquote(token: string): string {
  const t = token.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('`') && t.endsWith('`')))) {
    return t.slice(1, -1);
  }
  return t;
}

/** The module path declared by go.mod text: `module x`, `module "x"`, ``module `x` ``, or
 *  the block form `module ( x )`. The first declaration wins; undefined when there is none. */
export function parseGoModulePath(text: string): string | undefined {
  let inBlock = false;
  for (const rawLine of text.split('\n')) {
    const line = goLine(rawLine);
    if (line === '') continue;
    if (inBlock) {
      if (line === ')') {
        inBlock = false;
        continue;
      }
      const path0 = goUnquote(line);
      return path0 === '' ? undefined : path0;
    }
    const m = /^module(?:\s+|(?=[("`]))(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[1].trim();
    if (rest === '(') {
      inBlock = true;
      continue;
    }
    if (rest.startsWith('(') && rest.endsWith(')')) {
      const inner = goUnquote(rest.slice(1, -1));
      return inner === '' ? undefined : inner;
    }
    const value = goUnquote(rest);
    if (value !== '') return value;
  }
  return undefined;
}

/** The directories named by `use` directives in go.work text (single-line and block form,
 *  quoted or bare), as written — relative to the go.work directory. */
export function parseGoWorkUses(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const rawLine of text.split('\n')) {
    const line = goLine(rawLine);
    if (line === '') continue;
    if (inBlock) {
      if (line === ')') {
        inBlock = false;
        continue;
      }
      const dir = goUnquote(line);
      if (dir !== '') out.push(dir);
      continue;
    }
    const m = /^use(?:\s+|(?=\())(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[1].trim();
    if (rest === '(') {
      inBlock = true;
      continue;
    }
    const dir = goUnquote(rest.startsWith('(') && rest.endsWith(')') ? rest.slice(1, -1) : rest);
    if (dir !== '') out.push(dir);
  }
  return out;
}

/**
 * Build the disk-backed Java resolution capabilities for a project root. Java
 * resolution is pure file/directory existence (the package = directory convention),
 * so `exists` is shared with the other resolvers; the only extra capability is
 * listing a package directory's `.java` files for a wildcard import. `isExcluded`
 * flows straight through to `JavaResolveDeps` so both `resolveType` and
 * `resolveJavaPackageFiles` can skip an excluded hit and keep walking the
 * ancestor-source-root chain — see java-resolve.ts's own doc comment.
 *
 * NOTE: makeResolvePathToFile's deps are pure filesystem access;
 * readdirSync is fine there — it lists files, it does not parse.
 */
function makeJavaResolveDeps(
  projectRoot: string,
  exists: (repoRelPosix: string) => boolean,
  isExcluded?: (repoRelPosix: string) => boolean,
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
  return { exists, javaFilesIn, isExcluded };
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
  isExcluded?: (repoRelPosix: string) => boolean,
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

  return { psr4For, exists, isExcluded };
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
