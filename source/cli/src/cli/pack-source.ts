import path from 'node:path';
import { statSync } from 'node:fs';
import { rcompare as semverRcompare, valid as validSemver } from 'semver';

import { toPosixPath } from '../utils/posix.js';
import { debugWrite } from '../utils/debug-log.js';
import type { IssueMessage } from '../model/validation.js';
import type { Graph } from '../model/graph.js';
import type { MarketplaceEntry, PackageManifest, PackagesLock } from '../model/packages.js';
import type { PackagesLockEntry } from '../model/packages.js';
import { MARKETPLACE_FILENAME, PACKAGE_FILENAME, PACKAGES_DIR, PACKAGES_LOCK_FILENAME } from '../model/packages.js';
import {
  checkPackageRequires,
  parseMarketplaceManifest,
  parsePackageManifest,
  parsePackagesLock,
} from '../io/package-manifest-parser.js';
import {
  acquirePackCommandLock,
  createFetchStagingDir,
  installDirAbs,
  listPackageAspectDirs,
  packagesLockPath,
  removeDirectory,
  sweepFetchStagingDirs,
} from '../io/package-store.js';
import { recordObservedVersions } from '../io/package-versions-cache.js';
import {
  clonePackageSource,
  isGitRepositoryRoot,
  listPublishedVersionTags,
  packageVersionTag,
  readHeadCommit,
  readOriginUrl,
} from '../utils/git-pack-fetch.js';
import { cliVersion } from './cli-version.js';

/**
 * source/cli/src/cli/pack-source.ts — where an installed package comes from,
 * for the `yg pack` commands: reading what the user asked for, resolving a
 * source for this machine and for the committed record, working out who
 * published it, fetching exactly one published version of it, reading the
 * marketplace and the package, and the shared state every subcommand consults
 * (the record, the command lock, what the graph still attaches).
 *
 * A VERSION is a tag, `pack/<name>@<version>`. "Latest" is the highest such tag
 * the source publishes; a version is only ever taken from its tag, cloned, and
 * the commit the tag pointed at is recorded — never a default branch, and never a
 * local working tree, whose uncommitted state no teammate could reproduce. The
 * one exception is a plain directory that is not a git repository at all: it
 * publishes no versions, is read as it is on disk, and the record says so.
 *
 * Everything that refuses does so by throwing a {@link PackRefusal}, which the
 * command layer prints once every cleanup below it has run.
 */

/**
 * A refusal: a what/why/next the command decided on, carried to the one place
 * that prints it.
 *
 * Thrown rather than printed-and-exited on the spot. Exiting from inside a
 * command skipped every `finally` between the refusal and the top — which is how
 * a refused install left its full clone of the marketplace behind in
 * `.yggdrasil/` every time. Throwing lets the cleanup run first.
 */
export class PackRefusal extends Error {
  constructor(public readonly messageData: IssueMessage) {
    super(messageData.what);
    this.name = 'PackRefusal';
  }
}

/** Refuse with a what/why/next. Nothing after this line runs; the cleanup does. */
export function failWith(msg: IssueMessage): never {
  throw new PackRefusal(msg);
}

export interface PackageSpec {
  /** The URL or path, verbatim. */
  source: string;
  /** The package's name inside that marketplace. */
  name: string;
  /** The version asked for, when one was. */
  version?: string;
}

/**
 * Split `<source>#<name>[@<version>]`.
 *
 * `#` is split on FIRST because a git URL practically never contains one, while
 * `@` is common in the `git@host:owner/repo` form — so the fragment is found
 * first and the version is then split off the fragment's LAST `@`, never the
 * whole string's.
 */
export function parsePackageSpec(raw: string): PackageSpec | null {
  const hash = raw.indexOf('#');
  if (hash < 0) return null;
  const source = raw.slice(0, hash).trim();
  const fragment = raw.slice(hash + 1).trim();
  if (source === '' || fragment === '') return null;

  const at = fragment.lastIndexOf('@');
  if (at > 0) {
    const name = fragment.slice(0, at).trim();
    const version = fragment.slice(at + 1).trim();
    if (name === '' || version === '') return null;
    return { source, name, version };
  }
  return { source, name: fragment };
}

/** True when `source` names a directory that exists on this machine. */
export function isLocalDirectory(source: string): boolean {
  try {
    return statSync(source).isDirectory();
  } catch (err) {
    debugWrite(`[pack] local-directory probe of '${source}': ${(err as Error).message}`);
    return false;
  }
}

/** True when a local directory carries a marketplace manifest at its root. */
function isReadableMarketplaceDir(source: string): boolean {
  if (!isLocalDirectory(source)) return false;
  try {
    return statSync(path.join(source, MARKETPLACE_FILENAME)).isFile();
  } catch (err) {
    debugWrite(`[pack] no ${MARKETPLACE_FILENAME} in '${source}': ${(err as Error).message}`);
    return false;
  }
}

/**
 * True when a source string is a URL (or git's scp-like `host:path` form) rather
 * than a path on this machine. A Windows drive letter (`C:`) is a path.
 */
export function isUrlLike(source: string): boolean {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(source)) return true;
  if (/^[^\s/\\@]+@[^\s/\\:]+:/.test(source)) return true;
  return /^[A-Za-z0-9.-]{2,}:[^\\/]/.test(source) && !/^[A-Za-z]:/.test(source);
}

/**
 * Work an `<owner>/<repo>` identity out of a git URL.
 *
 * The last two path segments, with a trailing `.git` dropped — which covers the
 * https, ssh and scp-like forms alike. Anything that does not yield two segments
 * returns null, and the caller then asks the user to say who this is rather than
 * inventing an identity that two different repositories could collide on.
 */
export function identityFromUrl(url: string): string | null {
  const withoutProtocol = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/^[^/]*@/, '');
  const normalized = withoutProtocol.replace(':', '/');
  const segments = normalized
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (segments.length < 2) return null;
  const repo = segments[segments.length - 1].replace(/\.git$/, '');
  const owner = segments[segments.length - 2];
  if (owner === '' || repo === '') return null;
  return `${owner}/${repo}`;
}

/** A path segment safe to use as a directory name. */
function isSafeSegment(segment: string): boolean {
  return segment !== '' && segment !== '.' && segment !== '..' && !segment.includes('\\') && !segment.includes('/');
}

/** Validate an `<owner>/<repo>` identity, wherever it came from. */
export function validIdentity(identity: string): boolean {
  const parts = identity.split('/');
  return parts.length === 2 && parts.every(isSafeSegment);
}

/** The `<owner>/<repo>` half of an install id. */
export function ownerRepoOf(installId: string): string {
  return installId.split('/').slice(0, 2).join('/');
}

// ============================================================
// Where a package comes from
// ============================================================

/** A source resolved for this machine. */
export interface ResolvedSource {
  /** What git or the filesystem is handed: a URL, or an absolute path. */
  location: string;
  /** Whether that is a path on this machine. */
  local: boolean;
}

/** A source the user just typed: a path is resolved from where they typed it. */
export function resolveTypedSource(raw: string): ResolvedSource {
  return isUrlLike(raw) ? { location: raw, local: false } : { location: path.resolve(process.cwd(), raw), local: true };
}

/** A source the record holds: a path is resolved from the repository root. */
export function resolveRecordedSource(recorded: string, projectRoot: string): ResolvedSource {
  return isUrlLike(recorded)
    ? { location: recorded, local: false }
    : { location: path.resolve(projectRoot, recorded), local: true };
}

/**
 * The source as it goes into the committed record.
 *
 * A path is stored relative to the repository root, so it means the same thing
 * from any directory and on a teammate's machine that has the marketplace checked
 * out at the same place. A URL loses any credentials written into it — a token
 * in a URL would otherwise be committed for everyone to read.
 */
export function recordableSource(resolved: ResolvedSource, projectRoot: string): { source: string; strippedCredentials: boolean } {
  if (resolved.local) {
    const rel = toPosixPath(path.relative(projectRoot, resolved.location));
    if (rel === '') return { source: '.', strippedCredentials: false };
    if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return { source: toPosixPath(resolved.location), strippedCredentials: false };
    return { source: rel.startsWith('.') ? rel : `./${rel}`, strippedCredentials: false };
  }
  const match = /^(https?:\/\/|ftps?:\/\/)([^/@]+)@/.exec(resolved.location);
  if (match !== null) {
    return { source: resolved.location.replace(match[0], match[1]), strippedCredentials: true };
  }
  return { source: resolved.location, strippedCredentials: false };
}

/** How a source is read: a repository through its tags, or a plain directory as it is. */
export type SourceKind = 'git' | 'directory';

/**
 * Decide how to read a source, refusing a local path that is not there.
 *
 * A local git repository is read exactly as a remote one is — through its
 * published tags, cloned — so only committed, released content is ever installed
 * from it, never whatever its working tree happens to hold. A plain directory
 * (no repository of its own) publishes no versions at all and is read as it is
 * on disk; the record then says so.
 */
export async function sourceKindOf(resolved: ResolvedSource, recordedFor?: string): Promise<SourceKind> {
  if (!resolved.local) return 'git';
  if (!isLocalDirectory(resolved.location)) {
    failWith({
      what:
        recordedFor === undefined
          ? `There is no directory at '${toPosixPath(resolved.location)}'.`
          : `The source recorded for '${recordedFor}' is a path on this machine, '${toPosixPath(resolved.location)}', and nothing is there.`,
      why:
        recordedFor === undefined
          ? 'A source is a URL or a directory on this machine; this names neither.'
          : 'A path is recorded relative to the repository, so it resolves only where the marketplace is checked out at the same place relative to it — on this machine it is not. This is not a network failure; nothing was fetched.',
      next:
        recordedFor === undefined
          ? 'Check the path, or give the URL of the marketplace repository instead.'
          : `Check the marketplace out at that path, or point the record at its URL: set source: for '${recordedFor}' in .yggdrasil/${PACKAGES_LOCK_FILENAME} to the repository's URL and run this again. Nothing was installed or changed.`,
    });
  }
  if (await isGitRepositoryRoot(resolved.location)) return 'git';
  if (isReadableMarketplaceDir(resolved.location)) return 'directory';
  failWith({
    what: `There is no ${MARKETPLACE_FILENAME} in '${toPosixPath(resolved.location)}', and it is not a git repository either.`,
    why: 'A marketplace is a directory — or a repository — carrying that file at its root; without it there is nothing naming the packages published there.',
    next: `Point at a directory whose root holds ${MARKETPLACE_FILENAME}, or at the URL of a repository that does. Nothing was installed or changed.`,
  });
}

// ============================================================
// Fetching a published version
// ============================================================

/** What a caller wants from a source: its newest published version, or one exact version. */
export type Want = { kind: 'latest' } | { kind: 'exact'; version: string };

/** A package's marketplace, made readable, and exactly which published version it is. */
export interface Fetched {
  /** Absolute path of the marketplace root to read from. */
  rootAbs: string;
  /** The version of the tag it was taken from; undefined for a plain directory. */
  version?: string;
  /** `pack/<name>@<version>`; undefined for a plain directory. */
  tag?: string;
  /** The commit that tag points at; undefined for a plain directory. */
  commit?: string;
  /** Every version the source publishes for this package, when it could be asked. */
  published: string[] | null;
}

/** Semver-valid versions, newest first. A tag that is not semver cannot be ordered and is skipped. */
function newestFirst(versions: readonly string[]): string[] {
  return versions.filter((v) => validSemver(v) !== null).sort(semverRcompare);
}

/**
 * Everything one pack command fetches, asked for once and cleaned up once.
 *
 * A source's tags are listed with ONE `ls-remote` however many of its packages
 * the command works through, and a tag is cloned once however many packages sit
 * in it. Every directory a fetch made is removed by `cleanup()`, which the
 * command runs in a `finally` — refusal or success alike.
 */
export class FetchSession {
  private readonly tagLists = new Map<string, Promise<Map<string, string[]> | null>>();
  private readonly clones = new Map<string, Promise<{ dest: string; commit: string | null }>>();
  private readonly made: string[] = [];

  constructor(private readonly projectRoot: string) {}

  /** Every tag a source publishes, per package; null when it cannot be reached. */
  publishedBy(location: string): Promise<Map<string, string[]> | null> {
    let pending = this.tagLists.get(location);
    if (pending === undefined) {
      pending = listPublishedVersionTags(location);
      this.tagLists.set(location, pending);
    }
    return pending;
  }

  /** The versions one package is published at, or null when the source cannot be reached. */
  async versionsOf(location: string, name: string): Promise<string[] | null> {
    const all = await this.publishedBy(location);
    return all === null ? null : (all.get(name) ?? []);
  }

  /** Make the given version of a package readable, refusing what cannot be had. */
  async fetch(resolved: ResolvedSource, kind: SourceKind, name: string, want: Want): Promise<Fetched> {
    if (kind === 'directory') {
      if (want.kind === 'exact') {
        failWith({
          what: `'${toPosixPath(resolved.location)}' is a plain directory, so it has no version '${want.version}' of '${name}' to give.`,
          why: 'A version is a tag, pack/<package>@<version>, and only a git repository has tags. A plain directory is read as it is on disk, which is one unversioned state.',
          next: `Install from the marketplace's git repository (its URL, or the top of a checkout of it) to choose a version, or drop the version to take the directory as it is.`,
        });
      }
      return { rootAbs: resolved.location, published: null };
    }

    const published = await this.versionsOf(resolved.location, name);
    if (published === null) {
      failWith({
        what: `Could not reach '${resolved.location}'.`,
        why: 'Installing law from another repository means asking it which versions it publishes first, and this one did not answer (or asked for credentials, which a pack command never waits for).',
        next: 'Check the URL, your network and your git credentials, then run the command again. Nothing was installed or changed.',
      });
    }
    const available = newestFirst(published);

    let version: string;
    if (want.kind === 'exact') {
      if (!published.includes(want.version)) {
        failWith({
          what: `The source has no version '${want.version}' of '${name}' (looked for the tag ${packageVersionTag(name, want.version)}).`,
          why: `A version is a tag the marketplace publishes as pack/<package>@<version>. It publishes ${available.length === 0 ? 'no version of this package at all' : `these: ${available.join(', ')}`}. Nothing was installed or changed.`,
          next: available.length === 0 ? `Ask the author to publish a version by tagging it pack/${name}@<version>.` : `Choose one of the versions above.`,
        });
      }
      version = want.version;
    } else {
      if (available.length === 0) {
        failWith({
          what: `'${resolved.location}' publishes no version of '${name}'.`,
          why: `A version is a tag, pack/${name}@<version>, and there is none. Installing whatever its default branch holds would install unreleased work under a number nobody published — two repositories "at" that number could run different code. Nothing was installed or changed.`,
          next: `Ask the author to publish a version: tag the commit pack/${name}@<version> and push the tag. Then run this again.`,
        });
      }
      version = available[0];
    }

    const tag = packageVersionTag(name, version);
    const cloned = await this.cloneAt(resolved.location, tag);
    if (cloned.commit === null) {
      failWith({
        what: `The clone of ${tag} from '${resolved.location}' has no commit to record.`,
        why: 'The record names the exact commit a copy came from, so a moved tag can be noticed later.',
        next: 'Run the command again; if it keeps failing, run it with YG_DEBUG=1 and report the output.',
      });
    }
    return { rootAbs: cloned.dest, version, tag, commit: cloned.commit, published };
  }

  private cloneAt(location: string, tag: string): Promise<{ dest: string; commit: string | null }> {
    const key = `${location}\n${tag}`;
    let pending = this.clones.get(key);
    if (pending === undefined) {
      pending = this.doClone(location, tag);
      this.clones.set(key, pending);
    }
    return pending;
  }

  private async doClone(location: string, tag: string): Promise<{ dest: string; commit: string | null }> {
    const staging = await createFetchStagingDir(this.projectRoot);
    this.made.push(staging);
    const dest = path.join(staging, 'source');
    const result = await clonePackageSource(location, dest, tag);
    if (!result.ok) {
      failWith({
        what: `Could not fetch ${tag} from '${location}'.`,
        why: `The source lists that tag but the clone failed. The source reported: ${result.detail}`,
        next: 'Check your network and git credentials, then run the command again. Nothing was installed or changed.',
      });
    }
    return { dest, commit: await readHeadCommit(dest) };
  }

  /** Remove every directory this session made. */
  async cleanup(): Promise<void> {
    for (const dir of this.made.splice(0)) await removeDirectory(dir);
  }
}

// ============================================================
// Reading a marketplace
// ============================================================

export async function readMarketplaceEntry(rootAbs: string, packageName: string): Promise<MarketplaceEntry> {
  const manifestPath = path.join(rootAbs, MARKETPLACE_FILENAME);
  const manifest = await parseMarketplaceManifest(manifestPath);
  if (!manifest.ok) failWith(manifest.errors[0].messageData);

  const entry = manifest.value.packages.find((p) => p.name === packageName);
  if (entry === undefined) {
    const published = manifest.value.packages.map((p) => p.name).sort((a, b) => (a < b ? -1 : 1));
    failWith({
      what: `The marketplace does not publish a package named '${packageName}'.`,
      why: `Its ${MARKETPLACE_FILENAME} names ${published.length === 0 ? 'no packages at all' : `these: ${published.join(', ')}`}.`,
      next:
        published.length === 0
          ? 'Point at a marketplace that publishes something, or ask its author to add the package.'
          : `Re-run naming one of the packages above.`,
    });
  }
  return entry;
}

export async function readPackage(rootAbs: string, entry: MarketplaceEntry): Promise<{ manifest: PackageManifest; packageRootAbs: string }> {
  const packageRootAbs = path.join(rootAbs, ...entry.path.split('/'));
  let presentDirs: string[];
  try {
    presentDirs = await listPackageAspectDirs(packageRootAbs);
  } catch (err) {
    debugWrite(`[pack] reading package directory '${packageRootAbs}': ${(err as Error).message}`);
    failWith({
      what: `The marketplace says '${entry.name}' is at '${entry.path}', but there is no directory there.`,
      why: `A marketplace entry points at the directory holding the package's ${PACKAGE_FILENAME}.`,
      next: `Ask the marketplace author to correct the path: of '${entry.name}' in ${MARKETPLACE_FILENAME}.`,
    });
  }

  const manifest = await parsePackageManifest(path.join(packageRootAbs, PACKAGE_FILENAME), presentDirs);
  if (!manifest.ok) failWith(manifest.errors[0].messageData);

  // The marketplace says this package is called one thing and the package itself
  // says another. Installing anyway would file it under a name neither document
  // agrees on, and every later command — update, remove — addresses it by name.
  if (manifest.value.name !== entry.name) {
    failWith({
      what: `The marketplace publishes '${entry.name}', but the package at '${entry.path}' calls itself '${manifest.value.name}'.`,
      why: 'A package is installed, updated and removed by name, so the two have to agree on what that name is.',
      next: `Ask the marketplace author to make the name in ${MARKETPLACE_FILENAME} and the one in ${PACKAGE_FILENAME} match.`,
    });
  }

  const requires = checkPackageRequires(manifest.value, cliVersion());
  if (!requires.ok) failWith(requires.errors[0].messageData);

  return { manifest: manifest.value, packageRootAbs };
}

/**
 * The three places a version is written down must agree: the tag it was
 * published under, the package's own manifest, and the marketplace's entry.
 *
 * Recording the manifest's number when the tag said another would file two
 * different trees under one version — and "is there a newer one" would then be
 * answered against a number the source never published.
 */
export function assertVersionsAgree(fetched: Fetched, entry: MarketplaceEntry, manifest: PackageManifest): void {
  const claims: string[] = [];
  if (fetched.tag !== undefined) claims.push(`the tag ${fetched.tag}`);
  claims.push(`${PACKAGE_FILENAME} says ${manifest.version}`, `${MARKETPLACE_FILENAME} says ${entry.version}`);
  const expected = fetched.version ?? manifest.version;
  if (manifest.version === expected && entry.version === expected) return;
  failWith({
    what: `The version of '${manifest.name}' is written down three ways that disagree: ${claims.join(', ')}.`,
    why: 'A version names exactly one published tree. Recording one of the numbers while the others say something else would let two repositories claim the same version and run different code. Nothing was installed or changed.',
    next: `Ask the author to make the tag, version: in ${PACKAGE_FILENAME} and the entry in ${MARKETPLACE_FILENAME} agree, and publish again.`,
  });
}

// ============================================================
// Shared state
// ============================================================

export async function readLock(projectRoot: string): Promise<PackagesLock> {
  const lock = await parsePackagesLock(packagesLockPath(projectRoot));
  if (!lock.ok) failWith(lock.errors[0].messageData);
  return lock.value;
}

/** The repository a graph belongs to. Never the working directory: a command run from `src/sub` works on the same record as one run at the root. */
export function projectRootOf(graph: Graph): string {
  return path.dirname(graph.rootPath);
}

/** One place in the graph that names a rule. */
export interface Attachment {
  aspectId: string;
  where: string;
}

/**
 * Every place in the graph that names one of `ids`, from outside `ownPrefix`.
 *
 * Every kind of reference counts: a component's own list, one of its ports, a
 * type in the architecture, a flow, and another rule's `implies:` — any of them
 * left pointing at a rule that is gone fails every check on the dangling name.
 * References from inside the package itself are not counted: they go and come
 * with the package.
 */
export function attachmentsOf(graph: Graph, ids: ReadonlySet<string>, ownPrefix: string): Attachment[] {
  const out: Attachment[] = [];
  const named = (list: readonly string[] | undefined): string[] => (list ?? []).filter((id) => ids.has(id));
  for (const [nodePath, node] of graph.nodes) {
    for (const id of named(node.meta.aspects)) {
      out.push({ aspectId: id, where: `component ${nodePath}  (.yggdrasil/model/${nodePath}/yg-node.yaml)` });
    }
    for (const [portName, port] of Object.entries(node.meta.ports ?? {})) {
      for (const id of named(port.aspects)) {
        out.push({ aspectId: id, where: `port ${portName} of component ${nodePath}  (.yggdrasil/model/${nodePath}/yg-node.yaml)` });
      }
    }
  }
  for (const [typeId, type] of Object.entries(graph.architecture?.node_types ?? {})) {
    for (const id of named(type.aspects)) out.push({ aspectId: id, where: `type ${typeId}  (.yggdrasil/yg-architecture.yaml)` });
  }
  for (const flow of graph.flows) {
    for (const id of named(flow.aspects)) out.push({ aspectId: id, where: `flow ${flow.name}  (.yggdrasil/flows/${flow.path}/yg-flow.yaml)` });
  }
  for (const aspect of graph.aspects) {
    if (aspect.id === ownPrefix || aspect.id.startsWith(`${ownPrefix}/`)) continue;
    for (const id of named(aspect.implies)) {
      out.push({ aspectId: id, where: `rule ${aspect.id} implies it  (.yggdrasil/aspects/${aspect.id}/yg-aspect.yaml)` });
    }
  }
  return out.sort((a, b) => (a.where < b.where ? -1 : a.where > b.where ? 1 : 0));
}
// ============================================================
// new — scaffolding a package to publish
// ============================================================

/**
 * Hold the pack command lock for the length of `body`, and clear any fetch
 * directory a killed run left behind once it is held.
 */
export async function withCommandLock<T>(projectRoot: string, body: () => Promise<T>): Promise<T> {
  let release: () => Promise<void>;
  try {
    release = await acquirePackCommandLock(projectRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') throw err;
    debugWrite(`[pack] taking the pack command lock: ${(err as Error).message}`);
    failWith({
      what: `.yggdrasil/ is not writable here: ${(err as Error).message}`,
      why: `A pack command writes .yggdrasil/${PACKAGES_LOCK_FILENAME} and the copies under .yggdrasil/aspects/${PACKAGES_DIR}/, and takes a lock file beside them first so two commands never overwrite each other's record. Nothing was installed or changed.`,
      next: `Make .yggdrasil/ writable, then run the command again.`,
    });
  }
  try {
    await sweepFetchStagingDirs(projectRoot);
    return await body();
  } finally {
    await release();
  }
}

/** A short commit id for a reader; the record keeps the full one. */
export function shortCommit(commit: string | undefined): string {
  return commit === undefined ? '' : commit.slice(0, 12);
}

// ============================================================
// add
// ============================================================

/**
 * Who published this. From `--as` when given, otherwise from the URL, otherwise
 * from what a local checkout says its origin is.
 *
 * A local directory that is not a checkout, or has no origin, has nothing to go
 * on — and guessing (the directory's own name, say) would let two unrelated
 * copies install over each other. So it asks.
 */
export async function resolveIdentity(resolved: ResolvedSource, asOption: string | undefined, typed: string): Promise<string> {
  if (asOption !== undefined) return asOption;
  const derived = await deriveIdentity(resolved);
  if (derived !== null) return derived;
  if (resolved.local) {
    failWith({
      what: `Cannot tell who published the package at '${typed}'.`,
      why: 'A package is installed under the identity of the repository it came from, so two sources publishing the same name never collide. A local directory with no git origin says nothing about whose it is, and guessing from the directory name would let two unrelated packages overwrite each other.',
      next: 'Re-run with --as <owner>/<repo> to say who it is.',
    });
  }
  failWith({
    what: `Cannot read an <owner>/<repo> out of '${typed}'.`,
    why: 'A package is installed under the identity of the repository it came from, and this source does not carry one.',
    next: 'Re-run with --as <owner>/<repo> to say who it is.',
  });
}

/** The `<owner>/<repo>` a source says it is, or null when it says nothing. */
export async function deriveIdentity(resolved: ResolvedSource): Promise<string | null> {
  if (resolved.local) {
    if (!isLocalDirectory(resolved.location)) return null;
    const origin = await readOriginUrl(resolved.location);
    const fromOrigin = origin === null ? null : identityFromUrl(origin);
    return fromOrigin !== null && validIdentity(fromOrigin) ? fromOrigin : null;
  }
  const fromUrl = identityFromUrl(resolved.location);
  return fromUrl !== null && validIdentity(fromUrl) ? fromUrl : null;
}

// ============================================================
// update
// ============================================================

/**
 * Write down what a reachable source said it publishes, so the attention feed
 * can mention a newer version without reaching outside the repository itself.
 *
 * Best-effort, deliberately: this rides on commands whose real job is something
 * else, and a cache that cannot be written (a read-only checkout, a full disk)
 * must not turn one of them into a failure — the reader already has the answer
 * on their screen, and the next run writes it again.
 */
export async function rememberObservedVersions(
  yggRootPath: string,
  observed: Record<string, string[]>,
  anyReached: boolean,
): Promise<void> {
  if (!anyReached) return;
  try {
    await recordObservedVersions(yggRootPath, observed, new Date().toISOString());
  } catch (err) {
    debugWrite(`[pack] could not record published versions: ${(err as Error).message}`);
  }
}

// ============================================================
// verify
// ============================================================

/** Recorded files whose hash differs from, or is missing in, `now` — and files `now` has that the record does not. */
export function differingFiles(recorded: Record<string, string>, now: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const [file, hash] of Object.entries(recorded)) if (now[file] !== hash) out.add(file);
  for (const file of Object.keys(now)) if (!(file in recorded)) out.add(file);
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The rule directories the installed copy of a package holds. */
export async function installedRuleDirs(graph: Graph, projectRoot: string, entry: PackagesLockEntry): Promise<string[]> {
  const installedManifest = await parsePackageManifest(path.join(installDirAbs(projectRoot, entry.package), PACKAGE_FILENAME));
  if (installedManifest.ok) return installedManifest.value.aspects;
  debugWrite(`[pack] installed manifest of '${entry.package}' unreadable; reading its rules off the graph`);
  const prefix = `${PACKAGES_DIR}/${entry.package}/`;
  return graph.aspects.filter((a) => a.id.startsWith(prefix)).map((a) => a.id.slice(prefix.length));
}
