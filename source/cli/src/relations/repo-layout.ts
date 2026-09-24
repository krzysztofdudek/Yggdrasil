import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { parseCompileCommands, type CompileDb, type IncludeRoots } from './extractors/include-resolve.js';
import { parseComposerAutoload, type ComposerAutoload } from './extractors/php-resolve.js';

/**
 * Repository-wide build-layout facts the C/C++ and PHP path resolvers need beyond the
 * importing file's own ancestors: every directory named `include` (the C/C++ probe roots),
 * every `composer.json` (the PHP autoload union), and the C/C++ compilation database.
 *
 * Everything is discovered LAZILY, at most once per factory instance (one `yg check` pass),
 * and only when a resolver actually needs it: a repository without C/C++ or PHP never walks.
 * The walk skips dot-directories, `node_modules` and `vendor` (third-party trees whose
 * `composer.json` files describe installed packages, not this repository's own autoload
 * map), directories the graph excludes, and anything deeper than {@link MAX_DEPTH}; it stops
 * listing after {@link MAX_DIRS} directories so a pathological tree cannot stall a check.
 *
 * NOTE: like the other makeXResolveDeps factories this is pure filesystem access; it reads
 * and lists files, it does not parse source.
 */
const MAX_DEPTH = 12;
const MAX_DIRS = 50_000;
const SKIP_DIRS = new Set(['node_modules', 'vendor']);

interface Layout {
  includeDirs: string[];
  composerFiles: string[];
}

export interface RepoLayout {
  /** C/C++ include-root capabilities for `resolveIncludePath`. */
  includeRoots: IncludeRoots;
  /** Every in-repo composer.json's autoload maps (repo-rel dirs), in walk order. */
  composerMaps(): readonly ComposerAutoload[];
}

export function makeRepoLayout(
  projectRoot: string,
  isExcluded?: (repoRelPosix: string) => boolean,
): RepoLayout {
  let layout: Layout | undefined;
  const scan = (): Layout => {
    if (layout !== undefined) return layout;
    const found: Layout = { includeDirs: [], composerFiles: [] };
    const queue: Array<{ dir: string; depth: number }> = [{ dir: '', depth: 0 }];
    let visited = 0;
    while (queue.length > 0 && visited < MAX_DIRS) {
      const { dir, depth } = queue.shift()!;
      visited++;
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(path.join(projectRoot, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const rel = dir === '' ? e.name : `${dir}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
          if (isExcluded?.(rel) === true) continue;
          if (e.name === 'include') found.includeDirs.push(rel);
          if (depth + 1 <= MAX_DEPTH) queue.push({ dir: rel, depth: depth + 1 });
        } else if (e.isFile() && e.name === 'composer.json') {
          if (isExcluded?.(rel) === true) continue;
          found.composerFiles.push(rel);
        }
      }
    }
    layout = found;
    return layout;
  };

  // The compilation database: `compile_commands.json` at the repository root, else in
  // `build/`. The first one that parses into at least one in-repo translation unit wins.
  let db: CompileDb | null | undefined;
  const compileDb = (): CompileDb | undefined => {
    if (db !== undefined) return db ?? undefined;
    db = null;
    for (const dir of ['', 'build']) {
      const abs = path.join(projectRoot, dir, 'compile_commands.json');
      let text: string;
      try {
        text = readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      const parsed = parseCompileCommands(text, path.dirname(abs), path.resolve(projectRoot));
      if (parsed !== undefined) {
        db = parsed;
        break;
      }
    }
    return db ?? undefined;
  };

  let probe: string[] | undefined;
  const includeRoots: IncludeRoots = {
    compileDbRoots: (fromFile) => compileDb()?.rootsFor(fromFile),
    probeRoots: () => (probe ??= ['', ...scan().includeDirs]),
    isExcluded,
  };

  let maps: ComposerAutoload[] | undefined;
  const composerMaps = (): readonly ComposerAutoload[] => {
    if (maps !== undefined) return maps;
    maps = [];
    for (const file of scan().composerFiles) {
      let text: string;
      try {
        text = readFileSync(path.join(projectRoot, file), 'utf-8');
      } catch {
        continue;
      }
      const dir = path.posix.dirname(file);
      maps.push(parseComposerAutoload(text, dir === '.' ? '' : dir));
    }
    return maps;
  };

  return { includeRoots, composerMaps };
}
