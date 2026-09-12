import { mkdir, readdir, lstat, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { atomicWriteFile } from './atomic-write.js';
import { hashFile } from './hash.js';
import { toPosixPath } from '../utils/posix.js';
import type { IssueMessage } from '../model/validation.js';
import type { PackageConfigKeyDef, PackageManifest, PackagesLock, PackagesLockEntry } from '../model/packages.js';
import { ADAPT_FILENAME, PACKAGES_DIR, PACKAGES_LOCK_FILENAME } from '../model/packages.js';

/**
 * source/cli/src/io/package-store.ts — the filesystem half of consuming law from
 * someone else's repository: copy a package's files in, record what each one
 * hashed to, write the consumer's adapt stub beside each copied rule, and take a
 * package back out again.
 *
 * Nothing here runs git and nothing here parses a manifest. It receives an
 * already-fetched directory and an already-validated manifest, so the module that
 * shells out stays in the helper layer and this one stays in the layer that is
 * allowed to write.
 *
 * INSTALL IS ALL-OR-NOTHING. Files are copied into a dot-prefixed staging
 * directory first, the lock is written next, and only then does the staging
 * directory become the real one. The lock write is the step that can genuinely
 * fail on a real repository (a read-only file, a full disk); doing it while the
 * copy is still hidden means a failure there leaves NO copy directory behind at
 * all, rather than a half-installed rule set the graph would then try to load.
 * The staging name is dot-prefixed because the aspect scanner and this module's
 * own file walk both skip dot-prefixed entries, so a staging directory can never
 * register a phantom aspect even while it exists.
 */

/** Where an install identity lives, relative to `.yggdrasil/aspects/`. */
export function installDirRelative(installId: string): string {
  return `${PACKAGES_DIR}/${installId}`;
}

/** Absolute path of the aspects directory for `projectRoot`. */
export function aspectsRoot(projectRoot: string): string {
  return path.join(projectRoot, '.yggdrasil', 'aspects');
}

/** Absolute path of the consumer's package lock. */
export function packagesLockPath(projectRoot: string): string {
  return path.join(projectRoot, '.yggdrasil', PACKAGES_LOCK_FILENAME);
}

/**
 * True for a directory entry the package machinery ignores everywhere: the walk
 * that decides what to copy, the walk that decides what the lock records, and the
 * walk the file-modified rail uses to spot an unknown file. One predicate, so the
 * three can never disagree about whether a file belongs to a package — a
 * disagreement would either copy something the rail then rejects, or leave a file
 * the rail never looks at.
 *
 * Dot-prefixed entries are out because the aspect scanner skips them too (a
 * `.git` inside a copied tree is the obvious case), and `drills` stays IN: a
 * rule's regression cases are part of the rule.
 */
export function isIgnoredPackageEntry(name: string): boolean {
  return name.startsWith('.');
}

export type StoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; messageData: IssueMessage };

/** One file inside a package, relative to the package root, POSIX. */
interface PackageFile {
  relPath: string;
  absPath: string;
}

/**
 * Every file in a package directory, depth-first, sorted, dot-entries skipped.
 *
 * A symlink is REFUSED rather than followed or copied: a link inside a package
 * is authored by whoever published it and could point anywhere on the consuming
 * machine, and a copied link would still resolve against the consumer's own
 * filesystem after installation.
 */
async function collectPackageFiles(rootAbs: string): Promise<StoreResult<PackageFile[]>> {
  const out: PackageFile[] = [];

  async function walk(dirAbs: string, relPrefix: string): Promise<StoreResult<null>> {
    const entries = (await readdir(dirAbs, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (isIgnoredPackageEntry(entry.name)) continue;
      const abs = path.join(dirAbs, entry.name);
      const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`;
      const stats = await lstat(abs);
      if (stats.isSymbolicLink()) {
        return {
          ok: false,
          code: 'package-symlink-refused',
          messageData: {
            what: `The package carries a symbolic link at '${rel}'.`,
            why: 'A link published by someone else resolves against YOUR filesystem once copied in, so it could reach any file on this machine.',
            next: `Ask the package author to ship '${rel}' as a real file, or install a version of the package that does.`,
          },
        };
      }
      if (stats.isDirectory()) {
        const nested = await walk(abs, rel);
        if (!nested.ok) return nested;
        continue;
      }
      if (stats.isFile()) out.push({ relPath: rel, absPath: abs });
    }
    return { ok: true, value: null };
  }

  const walked = await walk(rootAbs, '');
  if (!walked.ok) return walked;
  return { ok: true, value: out };
}

/** The directory names sitting directly inside a package, dot-entries skipped. */
export async function listPackageAspectDirs(packageRootAbs: string): Promise<string[]> {
  const entries = await readdir(packageRootAbs, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !isIgnoredPackageEntry(e.name))
    .map((e) => e.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ============================================================
// The adapt stub
// ============================================================

/** Render one configuration default as the YAML scalar a consumer will edit. */
function renderConfigValue(value: string | number | boolean): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/**
 * The adapt file written beside a copied aspect.
 *
 * It is deliberately mostly comments: the point of the file is to be the place a
 * consumer reaches for INSTEAD of the copy, so it has to say what may be changed,
 * what may not, and why editing the copy is refused — at the moment they open it,
 * not in documentation elsewhere. The configuration block is the one part written
 * as live YAML, carrying the package's own defaults, because a key a consumer has
 * to discover before they can set it is a key nobody sets.
 */
export function renderAdaptStub(
  packageName: string,
  aspectDirName: string,
  configSchema: Record<string, PackageConfigKeyDef> | undefined,
): string {
  const lines: string[] = [
    `# Adaptation for the rule '${aspectDirName}', installed from the package '${packageName}'.`,
    '#',
    '# This file is yours. The rule beside it is not: every file the package',
    `# installed is recorded in .yggdrasil/${PACKAGES_LOCK_FILENAME}, and yg check`,
    '# refuses any edit to one. Change the rule from here instead — an update to a',
    '# newer version of the package replaces the copy and leaves this file alone.',
    '#',
    '# Adaptable keys (uncomment and edit):',
    '#   scope:      review granularity, e.g. { per: file }',
    '#   reviewer:   e.g. { tier: <a tier name from your yg-config.yaml> }',
    '#   review_by:  YYYY-MM-DD',
    '#   references: a list of repo-relative paths',
    '#   status:     draft | advisory | enforced',
    '#   companion:  repo-relative path to your own companion module',
    '#   config:     the keys below',
    '#',
    '# Not adaptable: name, implies, errs, when, and every code file. Those are what',
    '# the rule IS; changing them would make it a different rule wearing this name.',
  ];

  const schema = configSchema ?? {};
  const keys = Object.keys(schema).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (keys.length === 0) {
    lines.push('#', '# This rule reads no configuration.', '');
  } else {
    lines.push('', 'config:');
    for (const key of keys) {
      const def = schema[key];
      lines.push(`  # ${key} (${def.type}) — the package's own default`);
      lines.push(`  ${key}: ${renderConfigValue(def.default)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ============================================================
// Install
// ============================================================

export interface InstallPackageParams {
  projectRoot: string;
  /** `<owner>/<repo>/<name>` — where the copy lands under `aspects/packages/`. */
  installId: string;
  /** Absolute path of the package directory inside the fetched source. */
  packageRootAbs: string;
  manifest: PackageManifest;
  /** The source string, recorded verbatim in the lock. */
  source: string;
  /** ISO timestamp, injected — this module reads no clock. */
  installedAt: string;
  /** The lock as it stands, so a failed install can put it back. */
  currentLock: PackagesLock;
  /**
   * Adapt files already on disk, keyed by aspect directory name. An update
   * supplies these so a consumer's adaptation survives the copy being replaced;
   * a fresh install supplies none and gets generated stubs.
   */
  preserveAdapts?: Map<string, string>;
}

/**
 * Copy a package in and record it, all-or-nothing.
 *
 * Returns the lock entry that was written. Anything already installed under the
 * same identity is removed first: reaching here with a directory present and no
 * lock entry means a previous install died between its copy and its record, and
 * the only clean outcome is this install's own tree, never a merge of the two.
 */
export async function installPackage(
  params: InstallPackageParams,
): Promise<StoreResult<PackagesLockEntry>> {
  const { projectRoot, installId, packageRootAbs, manifest, source, installedAt, currentLock } = params;

  const collected = await collectPackageFiles(packageRootAbs);
  if (!collected.ok) return collected;

  const aspectsAbs = aspectsRoot(projectRoot);
  const finalRel = installDirRelative(installId);
  const finalAbs = path.join(aspectsAbs, ...finalRel.split('/'));
  const stagingAbs = path.join(
    aspectsAbs,
    PACKAGES_DIR,
    `.staging-${manifest.name}-${randomBytes(4).toString('hex')}`,
  );

  const files: Record<string, string> = {};
  try {
    await mkdir(stagingAbs, { recursive: true });

    for (const file of collected.value) {
      const bytes = await readFile(file.absPath);
      // A package is law — YAML, markdown, JavaScript, and the case files a rule
      // is drilled against. Copying is a text round-trip (read, then write through
      // the atomic helper, because every write in this layer goes through it), and
      // a text round-trip would silently mangle a binary. Say so instead.
      if (bytes.subarray(0, 8192).includes(0)) {
        // Refusing mid-copy still has to leave nothing behind: this return skips
        // the catch below, so the staging tree is removed here.
        await rm(stagingAbs, { recursive: true, force: true }).catch(() => {});
        return {
          ok: false,
          code: 'package-binary-file-refused',
          messageData: {
            what: `The package carries a binary file at '${file.relPath}'.`,
            why: 'A package ships rules and their case files — text. Copying a binary in would give you a file nothing here can read, check, or diff.',
            next: `Ask the package author to drop '${file.relPath}', or install a version of the package without it.`,
          },
        };
      }
      const destAbs = path.join(stagingAbs, ...file.relPath.split('/'));
      await mkdir(path.dirname(destAbs), { recursive: true });
      await atomicWriteFile(destAbs, bytes.toString('utf-8'));
      // Hashed from the file as WRITTEN, never from the source: the lock has to
      // describe the copy the rail will later compare against, and those two are
      // the same bytes only if the hash is taken on this side of the copy.
      files[`${finalRel}/${file.relPath}`] = await hashFile(destAbs);
    }

    // The adapt stubs. They are written into the staging tree so they arrive with
    // the copy, and they are NEVER added to `files` — the lock records what the
    // package shipped, and an adapt is the consumer's own writing.
    for (const aspectDir of manifest.aspects) {
      const adaptAbs = path.join(stagingAbs, aspectDir, ADAPT_FILENAME);
      const preserved = params.preserveAdapts?.get(aspectDir);
      await atomicWriteFile(
        adaptAbs,
        preserved ?? renderAdaptStub(manifest.name, aspectDir, manifest.config?.[aspectDir]),
      );
    }

    const entry: PackagesLockEntry = {
      source,
      package: installId,
      version: manifest.version,
      installed_at: installedAt,
      files,
    };
    const nextLock: PackagesLock = {
      schema: 'yg-packages/1',
      packages: { ...currentLock.packages, [manifest.name]: entry },
    };

    // The lock goes in BEFORE the copy is visible. If this throws, the catch
    // below removes the staging tree and no copy directory ever existed.
    await writePackagesLock(projectRoot, nextLock);

    try {
      await mkdir(path.dirname(finalAbs), { recursive: true });
      await rm(finalAbs, { recursive: true, force: true });
      await rename(stagingAbs, finalAbs);
    } catch (err) {
      // The copy could not take its place. Put the lock back the way it was, so
      // the repository is not left claiming to hold a package it does not.
      await writePackagesLock(projectRoot, currentLock);
      throw err;
    }

    return { ok: true, value: entry };
  } catch (err) {
    await rm(stagingAbs, { recursive: true, force: true }).catch(() => {});
    const detail = err instanceof Error ? err.message : String(err);
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      ok: false,
      code: 'package-install-failed',
      messageData: {
        what: `The package '${manifest.name}' could not be installed: ${detail}`,
        why:
          code === 'EACCES' || code === 'EPERM'
            ? `Installing writes .yggdrasil/${PACKAGES_LOCK_FILENAME} and the copy under .yggdrasil/aspects/${finalRel}; one of them is not writable.`
            : 'Installing copies the package in and records what every file hashed to; nothing is left half-written when either step fails.',
        next:
          code === 'EACCES' || code === 'EPERM'
            ? `Make .yggdrasil/${PACKAGES_LOCK_FILENAME} and .yggdrasil/aspects/ writable, then run the install again.`
            : 'Fix the reported cause and run the install again — nothing was left behind.',
      },
    };
  }
}

/**
 * A throwaway directory for a fetch, under `.yggdrasil/` and already ignored.
 *
 * Under the graph directory because every scrap of Yggdrasil-derived local state
 * belongs there, and named `*.tmp` because that is the one pattern the installed
 * `.yggdrasil/.gitignore` already covers — so a fetch leaves nothing to commit and
 * needs no change to what `yg init` writes. The caller removes it; the name also
 * means a fetch killed outright leaves something a reader can recognise as debris
 * rather than as part of the graph.
 */
export async function createFetchStagingDir(projectRoot: string): Promise<string> {
  const dir = path.join(projectRoot, '.yggdrasil', `pack-fetch-${randomBytes(6).toString('hex')}.tmp`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Remove a directory tree, swallowing every failure. Used to clean up a fetch. */
export async function removeDirectory(absDir: string): Promise<void> {
  await rm(absDir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Remove an installed package's copied files, and any owner/repo directory left
 * standing empty behind it. The lock entry is the caller's to drop.
 *
 * The empty parents matter because they are what a reader sees: leaving
 * `packages/acme/law/` behind after removing the only package under it says a
 * package from that publisher is still installed when none is. The walk up stops
 * at `packages/` itself and removes only directories that are actually empty, so
 * a sibling package is never touched.
 */
export async function removePackageFiles(projectRoot: string, installId: string): Promise<void> {
  const root = aspectsRoot(projectRoot);
  const segments = installDirRelative(installId).split('/');
  await rm(path.join(root, ...segments), { recursive: true, force: true });
  for (let depth = segments.length - 1; depth > 1; depth--) {
    const parent = path.join(root, ...segments.slice(0, depth));
    try {
      if ((await readdir(parent)).length > 0) return;
      // recursive:true on a directory just confirmed empty — `rm` refuses a
      // directory without it, and the emptiness check above is what makes it safe.
      await rm(parent, { recursive: true, force: true });
    } catch {
      return;
    }
  }
}

/** Read the adapt files currently sitting beside an installed package's aspects. */
export async function readInstalledAdapts(
  projectRoot: string,
  installId: string,
  aspectDirs: string[],
): Promise<Map<string, string>> {
  const base = path.join(aspectsRoot(projectRoot), ...installDirRelative(installId).split('/'));
  const found = new Map<string, string>();
  for (const dir of aspectDirs) {
    try {
      found.set(dir, await readFile(path.join(base, dir, ADAPT_FILENAME), 'utf-8'));
    } catch {
      // No adapt for this rule — the caller regenerates a stub. An unreadable one
      // is treated the same: a stub is always a correct starting point, and
      // failing the whole update over a file the consumer can rewrite would be
      // worse than replacing it.
    }
  }
  return found;
}

// ============================================================
// The lock file
// ============================================================

/**
 * Serialize the lock deterministically: package names sorted, file paths sorted,
 * so two installs of the same set produce byte-identical text and a diff shows
 * only what actually moved.
 */
export function renderPackagesLock(lock: PackagesLock): string {
  const lines: string[] = [
    '# Written by yg pack — what each installed package copied in, and what every',
    '# copied file hashed to. yg check refuses an edit to any file listed here;',
    `# adapt a rule in its ${ADAPT_FILENAME} instead.`,
    'schema: yg-packages/1',
  ];
  const names = Object.keys(lock.packages).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (names.length === 0) {
    lines.push('packages: {}');
    return `${lines.join('\n')}\n`;
  }
  lines.push('packages:');
  for (const name of names) {
    const entry = lock.packages[name];
    lines.push(`  ${JSON.stringify(name)}:`);
    lines.push(`    source: ${JSON.stringify(entry.source)}`);
    lines.push(`    package: ${JSON.stringify(entry.package)}`);
    lines.push(`    version: ${JSON.stringify(entry.version)}`);
    lines.push(`    installed_at: ${JSON.stringify(entry.installed_at)}`);
    const paths = Object.keys(entry.files).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (paths.length === 0) {
      lines.push('    files: {}');
      continue;
    }
    lines.push('    files:');
    for (const p of paths) lines.push(`      ${JSON.stringify(p)}: ${JSON.stringify(entry.files[p])}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Write the lock through the atomic-write port. */
export async function writePackagesLock(projectRoot: string, lock: PackagesLock): Promise<void> {
  await atomicWriteFile(packagesLockPath(projectRoot), renderPackagesLock(lock));
}

// ============================================================
// Reading an installed copy back
// ============================================================

/**
 * Every file actually present under a subtree of the packages area, as paths
 * relative to `.yggdrasil/aspects/`, sorted.
 *
 * An absent directory yields an empty list, not an error. Two callers depend on
 * that: a package the lock names but whose copy is gone is a finding for the
 * caller to report rather than a read failure here, and a repository with no
 * packages at all must read as "nothing there" without the caller first having to
 * ask whether the directory exists.
 */
async function listFilesUnder(absRoot: string, relRoot: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dirAbs: string, relPrefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isIgnoredPackageEntry(entry.name)) continue;
      const abs = path.join(dirAbs, entry.name);
      const rel = `${relPrefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        out.push(toPosixPath(rel));
      }
    }
  }

  await walk(absRoot, relRoot);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Files present under ONE installed package, relative to `.yggdrasil/aspects/`. */
export async function listInstalledFiles(projectRoot: string, installId: string): Promise<string[]> {
  const relRoot = installDirRelative(installId);
  return listFilesUnder(path.join(aspectsRoot(projectRoot), ...relRoot.split('/')), relRoot);
}

/**
 * Every file under the whole packages area, relative to `.yggdrasil/aspects/`.
 *
 * The file-modified rail compares this against the union of the lock's records,
 * which is how a file sitting under `packages/` that no installed package
 * accounts for gets noticed — the case that matters, because dropping a rule
 * beside someone else's is how a rule nobody chose would look like one they did.
 */
export async function listAllPackageFiles(projectRoot: string): Promise<string[]> {
  return listFilesUnder(path.join(aspectsRoot(projectRoot), PACKAGES_DIR), PACKAGES_DIR);
}

/** sha256 (line endings normalized) of one file addressed relative to `.yggdrasil/aspects/`. */
export async function hashAspectsRelativeFile(
  projectRoot: string,
  aspectsRelPath: string,
): Promise<string | null> {
  try {
    return await hashFile(path.join(aspectsRoot(projectRoot), ...aspectsRelPath.split('/')));
  } catch {
    return null;
  }
}
