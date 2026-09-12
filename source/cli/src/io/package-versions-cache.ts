import path from 'node:path';

import { atomicWriteFile } from './atomic-write.js';
import { ensureGitignoreLine } from './debug-log-writer.js';
import { readFileOrDefault } from './read-or-default.js';
import { debugWrite } from '../utils/debug-log.js';

/**
 * source/cli/src/io/package-versions-cache.ts — what each installed package's
 * source was last seen to publish.
 *
 * This is knowledge about the OUTSIDE WORLD, and it is kept deliberately apart
 * from `yg-packages.yaml`. That record is about integrity — what was copied in,
 * from where, and what every file hashed to — and it only changes when somebody
 * installs, updates or removes something. What another repository has published
 * since changes on its own, would rewrite a committed record on every listing,
 * and would legitimately differ between two machines. Conflating the two would
 * put churn into the one document whose stability is the point.
 *
 * It exists so `yg advise` can mention a newer version without reaching outside
 * this repository. That command is run by an agent every session, and everything
 * else it reports is derived from the graph, from git history, or from files on
 * disk — so two runs over an unchanged repository agree with each other. Asking
 * another repository a question does not have that property. So the asking
 * happens where a person asks about packages (`yg pack list`, `yg pack update`),
 * the answer lands here, and the feed reads a file like every other signal.
 *
 * Local and rebuildable, exactly like the deterministic verdict cache beside it:
 * dot-prefixed, gitignored, and thrown away with no loss — the next listing
 * writes it again. Nothing here is ever a hash ingredient, and the file-modified
 * rail never consults it.
 */

/** Filename relative to the `.yggdrasil/` graph root. Gitignored; never committed. */
export const PACKAGE_VERSIONS_CACHE_FILENAME = '.yg-packages-versions.json';

/** The schema token the reader requires before it will trust the document. */
export const PACKAGE_VERSIONS_CACHE_SCHEMA = 'yg-package-versions/1';

/** What one source was last seen to publish for one installed package. */
export interface PackageVersionsEntry {
  /** Every version tag the source published, verbatim. UNTRUSTED: it came from another repository. */
  published: string[];
  /** ISO timestamp of the reach that produced `published`. Never compared, only reported. */
  checked_at: string;
}

export interface PackageVersionsCache {
  schema: typeof PACKAGE_VERSIONS_CACHE_SCHEMA;
  /** Keyed by installed package name — the same name the installation record uses. */
  packages: Record<string, PackageVersionsEntry>;
}

/** An empty cache — what a repository that has never asked reads as. */
export function emptyPackageVersionsCache(): PackageVersionsCache {
  return { schema: PACKAGE_VERSIONS_CACHE_SCHEMA, packages: {} };
}

function cachePath(yggRootPath: string): string {
  return path.join(yggRootPath, PACKAGE_VERSIONS_CACHE_FILENAME);
}

/**
 * Read the cache. Absent, unreadable, or written by a build that shaped it
 * differently all read as EMPTY.
 *
 * Tolerant on purpose, and the tolerance is safe here in a way it would not be
 * for the installation record: the worst a lost cache can do is leave the
 * attention feed quiet about a newer version until the next listing. There is
 * nothing to fail closed about, and refusing would let a stale convenience block
 * commands that have nothing to do with it.
 */
export async function readPackageVersionsCache(yggRootPath: string): Promise<PackageVersionsCache> {
  const text = await readFileOrDefault(cachePath(yggRootPath), null, 'package-versions-cache');
  if (text === null) return emptyPackageVersionsCache();

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    debugWrite(`[package-versions-cache] unparseable, treated as empty: ${(err as Error).message}`);
    return emptyPackageVersionsCache();
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyPackageVersionsCache();
  const doc = raw as Record<string, unknown>;
  if (doc.schema !== PACKAGE_VERSIONS_CACHE_SCHEMA) {
    debugWrite(`[package-versions-cache] schema '${String(doc.schema)}' not understood, treated as empty`);
    return emptyPackageVersionsCache();
  }
  if (doc.packages === null || typeof doc.packages !== 'object' || Array.isArray(doc.packages)) {
    return emptyPackageVersionsCache();
  }

  const packages: Record<string, PackageVersionsEntry> = {};
  for (const [name, entryRaw] of Object.entries(doc.packages as Record<string, unknown>)) {
    if (entryRaw === null || typeof entryRaw !== 'object' || Array.isArray(entryRaw)) continue;
    const entry = entryRaw as Record<string, unknown>;
    if (!Array.isArray(entry.published) || !entry.published.every((v) => typeof v === 'string')) continue;
    if (typeof entry.checked_at !== 'string' || entry.checked_at.trim() === '') continue;
    packages[name] = {
      published: (entry.published as string[]).map((v) => v.trim()),
      checked_at: entry.checked_at.trim(),
    };
  }
  return { schema: PACKAGE_VERSIONS_CACHE_SCHEMA, packages };
}

/**
 * Serialize the cache deterministically — package names sorted, versions sorted
 * — so two listings that saw the same thing produce the same bytes and the file
 * stops changing once the answer stops changing.
 */
export function renderPackageVersionsCache(cache: PackageVersionsCache): string {
  const names = Object.keys(cache.packages).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const packages: Record<string, PackageVersionsEntry> = {};
  for (const name of names) {
    const entry = cache.packages[name];
    packages[name] = {
      published: [...entry.published].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      checked_at: entry.checked_at,
    };
  }
  return `${JSON.stringify({ schema: PACKAGE_VERSIONS_CACHE_SCHEMA, packages }, null, 2)}\n`;
}

/**
 * Write the cache, ensuring it stays out of the repository.
 *
 * The gitignore line is self-ensured here as a backstop, the same way the
 * feature-field index and the drill-results sidecar do it: `yg init` writes the
 * line, and a repository initialised by an older build still never commits this
 * file.
 */
export async function writePackageVersionsCache(
  yggRootPath: string,
  cache: PackageVersionsCache,
): Promise<void> {
  ensureGitignoreLine(yggRootPath, PACKAGE_VERSIONS_CACHE_FILENAME);
  await atomicWriteFile(cachePath(yggRootPath), renderPackageVersionsCache(cache));
}

/**
 * Fold what a listing just observed into the cache and write it.
 *
 * Only the packages actually reached are touched: a source that did not answer
 * keeps whatever was last recorded for it, because a failed reach is not
 * evidence that anything changed. A package that has been removed keeps its
 * entry too — harmless, since the feed only reports on packages the
 * installation record still knows about.
 */
export async function recordObservedVersions(
  yggRootPath: string,
  observed: Record<string, string[]>,
  checkedAt: string,
): Promise<void> {
  const cache = await readPackageVersionsCache(yggRootPath);
  const packages = { ...cache.packages };
  for (const [name, published] of Object.entries(observed)) {
    packages[name] = { published, checked_at: checkedAt };
  }
  await writePackageVersionsCache(yggRootPath, { schema: PACKAGE_VERSIONS_CACHE_SCHEMA, packages });
}
