import path from 'node:path';

/**
 * Resolve a PHP class FQN to a repo-relative POSIX `.php` source file, or undefined.
 *
 * The specifier is what the extractor emits: a PHP fully-qualified class name with `\`
 * separators and no leading backslash (`App\Payment\Gateway`).
 *
 * PHP maps a class FQN to a file through composer's PSR-4 autoloading. `composer.json`
 * declares `autoload.psr-4` (and `autoload-dev.psr-4`) — a map of namespace PREFIX to a
 * base DIRECTORY, e.g. `{ "App\\": "src/", "App\\Tests\\": "tests/" }`. For an FQN:
 *   - find the LONGEST psr-4 prefix that the FQN starts with (a prefix is a namespace
 *     boundary, ending in `\`);
 *   - the remainder after the prefix maps to `<baseDir>/<remainder-with-\→/>.php`;
 *   - check that file exists.
 * A PSR-4 prefix value may be an ARRAY of directories (one prefix → several roots) —
 * each candidate directory is tried. When the class file exists under EXACTLY ONE of
 * them the resolution is unambiguous and that file is returned; when it exists under
 * 2+ of them the FQN genuinely maps to two distinct files (two candidate owner nodes)
 * and resolution is AMBIGUOUS → undefined (silence). PSR-4 forbids the same class in
 * two roots at runtime (the first autoloader hit wins arbitrarily), so a static tool
 * MUST NOT pick one — guessing a root would be a false positive. This mirrors the
 * Java/Go multi-target rule (2+ distinct targets → silence, never first-wins).
 *
 * `deps.isExcluded`, when supplied, drops an excluded hit from that ambiguity count
 * BEFORE the exactly-one check runs: an excluded file is graph-told to not exist, so
 * it can never be the genuine target, and it must not keep a real, surviving hit
 * silenced merely because the class also used to live under a root the graph no
 * longer considers. Absent → no hit is ever dropped (today's behavior, unaffected).
 *
 * Longest-prefix matters because prefixes nest: with `App\` → `src/` and `App\Tests\` →
 * `tests/`, the FQN `App\Tests\UnitTest` must map under `tests/`, not `src/Tests/`.
 *
 * WHICH MAPS: the nearest ancestor composer.json first. When it resolves nothing (no
 * prefix matches, or the file is absent), the union of EVERY composer.json in the
 * repository is tried with the same exactly-one-hit rule — Composer registers the root
 * package and every path-repository package in one autoloader, so in a monorepo the
 * nearest map must not shadow the others. After the named PSR-4 prefixes come the
 * fallbacks: the PSR-4 empty prefix `""` (a fallback directory for every namespace, which
 * Composer documents) and PSR-0 (the whole FQN under the base directory, `_` in the class
 * name → `/`).
 *
 * FILE PATHS: a specifier containing `/` is not an FQN but a statically file-relative
 * `require`/`include` path emitted by the extractor; it is joined to the includer's
 * directory and resolves when that file exists.
 *
 * RESOLUTION MISS → undefined. This fail-to-silence is the false-positive guard: a
 * vendor / third-party class (its namespace is not in the project's psr-4 map), a
 * project that uses classmap / files autoload instead of psr-4 (no matching prefix), a
 * missing or unreadable composer.json, an FQN whose file is simply not present, or an
 * FQN whose file is present under 2+ roots of one prefix all resolve to nothing and are
 * never flagged. We never GUESS a root.
 */
export interface PhpResolveDeps {
  /**
   * The PSR-4 map in effect for `fromFile`: namespace prefix (ending in `\`) → one or
   * more base directories (repo-relative POSIX, no trailing slash; '' = repo root).
   * Read from the nearest ancestor composer.json. Empty map when none is found /
   * readable. Implementations SHOULD cache this — it is stable per composer.json root.
   */
  psr4For(fromFile: string): ReadonlyMap<string, readonly string[]>;
  /** Does a file exist at this repo-relative POSIX path? */
  exists(repoRelPosix: string): boolean;
  /**
   * Optional. True when the graph excludes this repo-relative POSIX path (a nested
   * project's own boundary, or a `coverage.excluded` root). A PSR-4 base-directory
   * hit that names an excluded file is dropped from the candidate set BEFORE the
   * exactly-one-hit ambiguity check runs, so a class the graph no longer considers
   * cannot keep a real, surviving copy under another root silenced. Absent → no hit
   * is ever dropped (today's behavior, unaffected).
   */
  isExcluded?(repoRelPosix: string): boolean;
  /**
   * Optional. The PSR-0 map of the same nearest composer.json that `psr4For` read (prefix →
   * base directories). Absent → no PSR-0 lookup.
   */
  psr0For?(fromFile: string): ReadonlyMap<string, readonly string[]>;
  /**
   * Optional. The autoload maps of EVERY composer.json in the repository (vendor/ excluded).
   * Consulted only when the nearest map resolves nothing: at runtime Composer registers the
   * root package and every path-repository package in one autoloader, so a monorepo's
   * cross-package class lives in a map the importing package's own composer.json does not
   * hold. Absent → no union fallback.
   */
  allMaps?(): readonly ComposerAutoload[];
}

/** One composer.json's autoload maps: PSR-4 (including the `""` fallback prefix) and
 *  PSR-0, each prefix → base directories (repo-relative POSIX, '' = repo root). */
export interface ComposerAutoload {
  psr4: ReadonlyMap<string, readonly string[]>;
  psr0: ReadonlyMap<string, readonly string[]>;
}

type MapsResult = { kind: 'hit'; file: string } | { kind: 'ambiguous' } | { kind: 'miss' };

/**
 * Resolve an FQN against a set of autoload maps with the exactly-one-hit rule.
 *   Stage A — named PSR-4 prefixes: per map, the LONGEST matching named prefix, every base
 *     directory of it. The hits of all maps are pooled.
 *   Stage B — only when stage A found no file: the fallbacks, i.e. each map's PSR-4 `""`
 *     directories (the whole FQN as a path under them) and every matching PSR-0 prefix
 *     (the whole FQN as a path, `_` in the class name → `/`).
 * Excluded hits are dropped first; one distinct live file → hit, 2+ → ambiguous, 0 → miss.
 */
function resolveInMaps(fqn: string, maps: readonly ComposerAutoload[], deps: PhpResolveDeps): MapsResult {
  const isExcl = deps.isExcluded ?? ((): boolean => false);
  const decide = (hits: Set<string>): MapsResult | undefined => {
    const live = [...hits].filter((h) => !isExcl(h));
    if (live.length === 0) return undefined;
    if (live.length > 1) return { kind: 'ambiguous' };
    return { kind: 'hit', file: live[0] };
  };
  const fqnWithSep = fqn + '\\';
  const segments = fqn.split('\\').filter((x) => x.length > 0);
  const fullPath = segments.join('/') + '.php';

  const stageA = new Set<string>();
  for (const map of maps) {
    let bestPrefix: string | undefined;
    for (const prefix of map.psr4.keys()) {
      if (prefix === '' || !fqnWithSep.startsWith(prefix)) continue;
      if (bestPrefix === undefined || prefix.length > bestPrefix.length) bestPrefix = prefix;
    }
    if (bestPrefix === undefined) continue;
    const remainder = fqn.slice(bestPrefix.length).split('\\').filter((x) => x.length > 0);
    if (remainder.length === 0) continue;
    const subPath = remainder.join('/') + '.php';
    for (const baseDir of map.psr4.get(bestPrefix) ?? []) {
      const candidate = joinUnder(baseDir, subPath);
      if (deps.exists(candidate)) stageA.add(candidate);
    }
  }
  const a = decide(stageA);
  if (a !== undefined) return a;

  const stageB = new Set<string>();
  const psr0Path = psr0PathOf(segments);
  for (const map of maps) {
    for (const baseDir of map.psr4.get('') ?? []) {
      const candidate = joinUnder(baseDir, fullPath);
      if (deps.exists(candidate)) stageB.add(candidate);
    }
    for (const [prefix, dirs] of map.psr0) {
      if (prefix !== '' && !fqn.startsWith(prefix)) continue;
      for (const baseDir of dirs) {
        const candidate = joinUnder(baseDir, psr0Path);
        if (deps.exists(candidate)) stageB.add(candidate);
      }
    }
  }
  return decide(stageB) ?? { kind: 'miss' };
}

/** PSR-0 path of an FQN: namespace segments as directories, and `_` in the CLASS-name
 *  segment (never in the namespace) as a directory separator too. */
function psr0PathOf(segments: string[]): string {
  const ns = segments.slice(0, -1);
  const cls = (segments[segments.length - 1] ?? '').split('_').filter((x) => x.length > 0);
  return [...ns, ...cls].join('/') + '.php';
}

/**
 * Resolve a statically file-relative `require`/`include` path. The extractor emits it as a
 * path relative to the includer's directory, always containing `/` (`./../lib/x.php`), which
 * no PHP FQN ever does. Joined to the includer's directory; a path that escapes the repository,
 * does not exist, or is excluded → undefined.
 */
function resolvePhpFilePath(specifier: string, fromFile: string, deps: PhpResolveDeps): string | undefined {
  const fromDir = path.posix.dirname(fromFile.replace(/\\/g, '/'));
  const joined = path.posix.normalize(path.posix.join(fromDir === '.' ? '' : fromDir, specifier));
  if (joined === '..' || joined.startsWith('../') || joined.startsWith('/')) return undefined;
  if (!deps.exists(joined)) return undefined;
  if (deps.isExcluded?.(joined) === true) return undefined;
  return joined;
}

export function resolvePhpFqn(
  specifier: string,
  fromFile: string,
  deps: PhpResolveDeps,
): string | undefined {
  if (specifier.includes('/')) return resolvePhpFilePath(specifier, fromFile, deps);
  const fqn = specifier.startsWith('\\') ? specifier.slice(1) : specifier;
  if (fqn === '') return undefined;

  // 1. The nearest composer.json's maps. Ambiguous there → silence; a hit → done.
  const nearest: ComposerAutoload = {
    psr4: deps.psr4For(fromFile),
    psr0: deps.psr0For?.(fromFile) ?? new Map(),
  };
  if (nearest.psr4.size > 0 || nearest.psr0.size > 0) {
    const r = resolveInMaps(fqn, [nearest], deps);
    if (r.kind === 'hit') return r.file;
    if (r.kind === 'ambiguous') return undefined;
  }
  // 2. Nothing in the nearest map: the union of every composer.json in the repository.
  const all = deps.allMaps?.() ?? [];
  if (all.length === 0) return undefined;
  const r = resolveInMaps(fqn, all, deps);
  return r.kind === 'hit' ? r.file : undefined;
}

/** Join a repo-relative directory with a sub-path, normalizing. '' → the sub-path itself. */
function joinUnder(dir: string, sub: string): string {
  return path.posix.normalize(dir === '' ? sub : path.posix.join(dir, sub));
}

/**
 * Parse a composer.json's `autoload.psr-4` and `autoload-dev.psr-4` into the normalized
 * prefix → directories map, with directories made relative to `composerDir` (repo-rel
 * POSIX, '' = repo root). Exported for the disk-backed deps factory and for testing.
 *
 * A prefix is kept verbatim (it ends in `\` per PSR-4 convention). A directory value is
 * a single string or an array of strings; each is normalized (trailing slash dropped,
 * `.`/`''` → the composerDir itself). Malformed entries are skipped. autoload-dev keys
 * supplement the main map (a key present in both takes the union of directories).
 */
export function parsePsr4(
  composerJsonText: string,
  composerDir: string,
): Map<string, string[]> {
  return parseAutoloadSection(composerJsonText, composerDir, 'psr-4');
}

/** Parse both autoload kinds of a composer.json (see {@link parsePsr4}); PSR-0 uses the same
 *  prefix → directories shape (a PSR-0 prefix need not end in `\`, e.g. `Twig_`). */
export function parseComposerAutoload(composerJsonText: string, composerDir: string): ComposerAutoload {
  return {
    psr4: parseAutoloadSection(composerJsonText, composerDir, 'psr-4'),
    psr0: parseAutoloadSection(composerJsonText, composerDir, 'psr-0'),
  };
}

function parseAutoloadSection(
  composerJsonText: string,
  composerDir: string,
  kind: 'psr-4' | 'psr-0',
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(composerJsonText);
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== 'object') return out;

  const addSection = (section: unknown): void => {
    if (section === null || typeof section !== 'object') return;
    for (const [prefix, value] of Object.entries(section as Record<string, unknown>)) {
      // An empty prefix is kept: Composer documents `"": "dir/"` as a fallback directory
      // for every namespace (resolution tries it only after every named prefix).
      const dirs = Array.isArray(value) ? value : [value];
      for (const d of dirs) {
        if (typeof d !== 'string') continue;
        const rel = normalizeDir(d, composerDir);
        const existing = out.get(prefix);
        if (existing === undefined) out.set(prefix, [rel]);
        else if (!existing.includes(rel)) existing.push(rel);
      }
    }
  };

  const autoload = (parsed as Record<string, unknown>).autoload;
  const autoloadDev = (parsed as Record<string, unknown>)['autoload-dev'];
  if (autoload !== null && typeof autoload === 'object') {
    addSection((autoload as Record<string, unknown>)[kind]);
  }
  if (autoloadDev !== null && typeof autoloadDev === 'object') {
    addSection((autoloadDev as Record<string, unknown>)[kind]);
  }
  return out;
}

/** A composer.json directory value → repo-relative POSIX dir (no trailing slash).
 *  `composerDir` is where the composer.json lives ('' = repo root); the value is relative
 *  to it. `''`, `.`, `./` all denote composerDir itself. */
function normalizeDir(value: string, composerDir: string): string {
  const trimmed = value.replace(/\/+$/, ''); // drop trailing slashes
  if (trimmed === '' || trimmed === '.') return composerDir;
  const joined = composerDir === '' ? trimmed : path.posix.join(composerDir, trimmed);
  const norm = path.posix.normalize(joined);
  return norm === '.' ? '' : norm;
}
