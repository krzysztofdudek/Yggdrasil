import type { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import { statSync, existsSync } from 'node:fs';
import { parseDocument, isSeq } from 'yaml';

import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { findUpwards } from './marketplace.js';
import { atomicWriteFile } from '../io/atomic-write.js';
import { readTextFile } from '../io/graph-fs.js';
import { toPosixPath } from '../utils/posix.js';
import { exitAfterFlush } from './exit-after-flush.js';
import { debugWrite } from '../utils/debug-log.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import type { IssueMessage } from '../model/validation.js';
import type { Graph } from '../model/graph.js';
import type { MarketplaceEntry, PackageManifest, PackagesLock } from '../model/packages.js';
import {
  ADAPT_FILENAME,
  MARKETPLACE_FILENAME,
  PACKAGE_FILENAME,
  PACKAGES_DIR,
  PACKAGES_LOCK_FILENAME,
} from '../model/packages.js';
import {
  checkPackageRequires,
  parseMarketplaceManifest,
  parsePackageManifest,
  parsePackagesLock,
} from '../io/package-manifest-parser.js';
import {
  createFetchStagingDir,
  installPackage,
  installDirRelative,
  listPackageAspectDirs,
  packagesLockPath,
  readInstalledAdapts,
  removeDirectory,
  removePackageFiles,
  writePackagesLock,
} from '../io/package-store.js';
import { collectPackagesDrift, isCopyIntact, repoRelativePackagePath } from '../core/checks/packages.js';
import { recordObservedVersions } from '../io/package-versions-cache.js';
import { newerThanInstalled } from '../core/advise-package-nominations.js';
import { clonePackageSource, listPackageVersionTags, packageVersionTag, readOriginUrl } from '../utils/git-pack-fetch.js';
import { cliVersion } from './cli-version.js';

/**
 * `yg pack` — install law published by someone else, keep it as they published
 * it, and adapt it beside the copy.
 *
 * There is no registry and no resolver. A marketplace is an ordinary git
 * repository with a manifest at its root; a package inside it is a directory of
 * ordinary rules. `add` copies one in and records what every file hashed to;
 * `update` replaces the copy with a newer version and leaves your adaptation
 * alone; `list` says what is installed and whether the copies are untouched;
 * `remove` takes one back out.
 *
 * The copy is never edited. Everything a repository wants different goes in the
 * `yg-aspect.adapt.yaml` written beside each installed rule, which is what lets an
 * update be a replacement rather than a merge.
 *
 * SECURITY: installing a package means running its code. A rule's check runs in
 * this process on every `yg check`, with everything this process can reach. What
 * is sandboxed is what the rule can READ THROUGH the context it is handed — not
 * the module itself. Install from a source you would give a shell to.
 */

function handleError(error: unknown): never {
  debugWrite(`[pack] command failed: ${(error as Error).message}`);
  abortOnUnexpectedError(error, 'running pack command');
}

/** Emit a blocking what/why/next error to stderr and exit(1) — nothing is written. */
function failWith(msg: IssueMessage): never {
  process.stderr.write(chalk.red(`Error: ${buildIssueMessage(msg)}`) + '\n');
  process.exit(1);
}

// ============================================================
// Parsing what the user asked for
// ============================================================

interface PackageSpec {
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
function parsePackageSpec(raw: string): PackageSpec | null {
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
function isLocalDirectory(source: string): boolean {
  try {
    return statSync(source).isDirectory();
  } catch (err) {
    debugWrite(`[pack] local-directory probe of '${source}': ${(err as Error).message}`);
    return false;
  }
}

/**
 * True when a local directory can be read as a marketplace where it sits.
 *
 * The test is the manifest, not "is this a git repository". A checked-out
 * marketplace has the manifest in its working tree and can be read directly; a
 * BARE repository is also a directory, but its manifest lives inside packed
 * objects, so it has to be cloned first. Testing for the file rather than for
 * `.git` gets both right without having to recognise every shape a repository
 * can take on disk.
 */
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
 * Work an `<owner>/<repo>` identity out of a git URL.
 *
 * The last two path segments, with a trailing `.git` dropped — which covers the
 * https, ssh and scp-like forms alike. Anything that does not yield two segments
 * returns null, and the caller then asks the user to say who this is rather than
 * inventing an identity that two different repositories could collide on.
 */
function identityFromUrl(url: string): string | null {
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
function validIdentity(identity: string): boolean {
  const parts = identity.split('/');
  return parts.length === 2 && parts.every(isSafeSegment);
}

// ============================================================
// Fetching
// ============================================================

interface FetchedSource {
  /** Absolute path of the marketplace root to read from. */
  rootAbs: string;
  /** Directory to remove when done, when the fetch made one. */
  cleanup?: string;
}

/**
 * Make a marketplace's tree readable, cloning it when it is not already a
 * directory on this machine — or when a specific version was asked for, since a
 * version is a tag and only a clone can check one out.
 */
async function fetchSource(
  projectRoot: string,
  source: string,
  packageName: string,
  version: string | undefined,
): Promise<FetchedSource> {
  if (version === undefined && isReadableMarketplaceDir(source)) {
    return { rootAbs: path.resolve(source) };
  }

  const staging = await createFetchStagingDir(projectRoot);
  const dest = path.join(staging, 'source');
  const ref = version === undefined ? undefined : packageVersionTag(packageName, version);
  const result = await clonePackageSource(source, dest, ref);
  if (!result.ok) {
    await removeDirectory(staging);
    if (result.reason === 'ref-missing') {
      failWith({
        what: `The source has no version '${version}' of '${packageName}' (looked for the tag ${ref}).`,
        why: `A version is a tag the marketplace publishes as pack/<package>@<version>; nothing was installed or changed. The source reported: ${result.detail}`,
        next: `Ask the source which versions it publishes, or drop the @<version> to take whatever its manifest currently names.`,
      });
    }
    // A path that is right there on this machine and that git cannot read is not
    // "unreachable" in any sense the reader would recognise: it is a directory
    // that is neither a repository nor a marketplace. Say the thing that is
    // actually missing rather than reporting a local path as a network failure.
    if (isLocalDirectory(source)) {
      failWith({
        what: `There is no ${MARKETPLACE_FILENAME} in '${source}', and it is not a git repository either.`,
        why: 'A marketplace is a directory — or a repository — carrying that file at its root; without it there is nothing naming the packages published there.',
        next: `Point yg pack add at a directory whose root holds ${MARKETPLACE_FILENAME}, or at the URL of a repository that does. Nothing was installed or changed.`,
      });
    }
    failWith({
      what: `Could not reach '${source}'.`,
      why: `Installing law from another repository means fetching it first, and this one did not answer. The source reported: ${result.detail}`,
      next: 'Check the URL and your network, then run the command again. Nothing was installed or changed.',
    });
  }
  return { rootAbs: dest, cleanup: staging };
}

// ============================================================
// Reading a marketplace
// ============================================================

async function readMarketplaceEntry(rootAbs: string, packageName: string): Promise<MarketplaceEntry> {
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

async function readPackage(rootAbs: string, entry: MarketplaceEntry): Promise<{ manifest: PackageManifest; packageRootAbs: string }> {
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

// ============================================================
// Shared state
// ============================================================

async function readLock(projectRoot: string): Promise<PackagesLock> {
  const lock = await parsePackagesLock(packagesLockPath(projectRoot));
  if (!lock.ok) failWith(lock.errors[0].messageData);
  return lock.value;
}

/** Every place in the graph that still attaches a rule from the given install. */
function attachmentsOf(graph: Graph, idPrefix: string): { nodes: string[]; types: string[]; flows: string[] } {
  const belongs = (aspectId: string): boolean => aspectId === idPrefix || aspectId.startsWith(`${idPrefix}/`);
  const nodes: string[] = [];
  for (const [nodePath, node] of graph.nodes) {
    if ((node.meta.aspects ?? []).some(belongs)) nodes.push(nodePath);
  }
  const types: string[] = [];
  for (const [typeId, type] of Object.entries(graph.architecture?.node_types ?? {})) {
    if ((type.aspects ?? []).some(belongs)) types.push(typeId);
  }
  const flows: string[] = [];
  for (const flow of graph.flows) {
    if ((flow.aspects ?? []).some(belongs)) flows.push(flow.name);
  }
  return { nodes: nodes.sort(), types: types.sort(), flows: flows.sort() };
}

// ============================================================
// new — scaffolding a package to publish
// ============================================================

/** The one aspect directory a scaffolded package starts with. */
const SCAFFOLD_ASPECT = 'example';

/** The setting that aspect reads — deliberately the same word, so the pairing is obvious. */
const SCAFFOLD_CONFIG_KEY = 'example';

/**
 * The package manifest a new package starts from.
 *
 * `requires.yg` is pinned to the running MAJOR rather than to this exact build:
 * a package written today against 6.1 works on 6.4, and a range naming the patch
 * would refuse consumers for no reason. The version starts at 0.1.0 — publishing
 * is tagging, and the author decides when the first real number is.
 */
export function scaffoldPackageManifest(name: string, version: string): string {
  const major = version.split('.')[0];
  return [
    `schema: yg-package/1`,
    `name: ${name}`,
    `version: 0.1.0`,
    `requires:`,
    `  yg: ">=${major}.0.0"`,
    `aspects:`,
    `  - ${SCAFFOLD_ASPECT}`,
    `config:`,
    `  # Settings the rules in this package read through ctx.config. A consumer`,
    `  # overrides them in the yg-aspect.adapt.yaml beside their copy, and a setting`,
    `  # a rule READS enters that rule's verdict — so changing it re-opens exactly`,
    `  # the rules that consult it, and nothing else.`,
    `  ${SCAFFOLD_ASPECT}:`,
    `    ${SCAFFOLD_CONFIG_KEY}:`,
    `      type: string`,
    `      default: "TODO"`,
    ``,
  ].join('\n');
}

/** The rule definition of the scaffolded example aspect. */
export function scaffoldAspectYaml(): string {
  return [
    `# An ordinary Yggdrasil rule. Two things differ inside a package:`,
    `#   - a rule that bundles another names it by directory alone (implies: [other]),`,
    `#     because the package does not know where it will be installed;`,
    `#   - review_by: and references: belong to the repository that INSTALLS a rule,`,
    `#     not to the one that publishes it.`,
    `name: NoUnfinishedMarker`,
    `description: A source line must not carry the marker this repository uses for unfinished work.`,
    `reviewer:`,
    `  type: deterministic`,
    `status: draft`,
    ``,
  ].join('\n');
}

/** The scaffolded example rule — the smallest one that reads a setting. */
export function scaffoldCheckScript(): string {
  return [
    `// The marker is NOT written into this rule: it is read from ctx.config, which`,
    `// the installing repository sets beside its copy. Reading it here is what puts`,
    `// the value into this rule's verdicts, so changing it sends this rule's`,
    `// verdicts back for judging and leaves every other rule's alone.`,
    `export function check(ctx) {`,
    `  const marker = ctx.config.${SCAFFOLD_CONFIG_KEY};`,
    `  const violations = [];`,
    `  for (const file of ctx.subject) {`,
    `    const lines = file.content.split('\\n');`,
    `    for (let i = 0; i < lines.length; i++) {`,
    `      if (lines[i].includes(marker)) {`,
    `        violations.push({`,
    `          file: file.path,`,
    `          line: i + 1,`,
    `          message: \`This line still carries the \${marker} marker.\`,`,
    `        });`,
    `      }`,
    `    }`,
    `  }`,
    `  return violations;`,
    `}`,
    ``,
  ].join('\n');
}

/**
 * Add one package entry to a marketplace manifest, keeping everything else.
 *
 * Edited as a YAML DOCUMENT rather than as text: the manifest is the author's
 * file and carries their comments, and re-serialising it from plain data would
 * silently delete them. The one adjustment is style — a manifest that starts life
 * as `packages: []` would otherwise grow its first entry inline, and every entry
 * after that too.
 */
export function withPackageEntry(manifestText: string, name: string, version: string): string {
  const doc = parseDocument(manifestText);
  const seq = doc.getIn(['packages'], true);
  if (!isSeq(seq)) {
    failWith({
      what: `${MARKETPLACE_FILENAME} has no packages: list to add to.`,
      why: 'packages: is the list of what this marketplace publishes. Without it there is nowhere to record the new package, and it would be published by nothing.',
      next: `Add \`packages: []\` to ${MARKETPLACE_FILENAME}, or run \`yg marketplace init\` in a repository that has no manifest yet.`,
    });
  }
  seq.flow = false;
  doc.addIn(['packages'], doc.createNode({ name, path: `${PACKAGES_DIR}/${name}`, version }));
  return doc.toString();
}

/** True when `name` is one path segment — no separators, no traversal, not empty. */
function isPackageName(name: string): boolean {
  return (
    name.trim() !== '' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    name !== '.' &&
    name !== '..'
  );
}

async function runNew(rawName: string): Promise<void> {
  const name = rawName.trim();
  if (!isPackageName(name)) {
    failWith({
      what: `'${rawName}' is not a package name.`,
      why: 'A package name becomes one directory here and one directory under aspects/packages/<owner>/<repo>/ in every repository that installs it, so it is a single path segment and never a path.',
      next: 'Choose a name with no / and no \\, such as `house-style`.',
    });
  }

  const cwd = process.cwd();
  const root = findUpwards(cwd, MARKETPLACE_FILENAME);
  if (root === null) {
    failWith({
      what: `There is no ${MARKETPLACE_FILENAME} at ${toPosixPath(cwd)} or above it.`,
      why: 'A package is published BY a marketplace — the manifest at the repository root is what names it and what a consumer reads to find it. Without one there is nothing for a new package to belong to.',
      next: 'Run `yg marketplace init` in the repository that should publish this package, then run this again.',
    });
  }

  const packageDir = path.join(root, PACKAGES_DIR, name);
  if (existsSync(packageDir)) {
    failWith({
      what: `${PACKAGES_DIR}/${name} already exists in ${toPosixPath(root)}.`,
      why: 'Scaffolding over it would overwrite the rule files that are there, and there is no way to tell a half-written package from a finished one from the outside.',
      next: `Choose another name, or delete ${PACKAGES_DIR}/${name} if it is not wanted.`,
    });
  }

  // The manifest is read and rewritten FIRST: it is the one file that could
  // legitimately be malformed already, and refusing before anything is scaffolded
  // is what keeps a failure from leaving a package directory nothing publishes.
  const manifestPath = path.join(root, MARKETPLACE_FILENAME);
  const existing = await parseMarketplaceManifest(manifestPath);
  if (!existing.ok) failWith(existing.errors[0].messageData);
  if (existing.value.packages.some((entry) => entry.name === name)) {
    failWith({
      what: `${MARKETPLACE_FILENAME} already publishes a package called '${name}'.`,
      why: 'Two entries under one name make the name ambiguous — a consumer asking for it could get either.',
      next: `Choose another name, or remove the existing '${name}' entry from ${MARKETPLACE_FILENAME}.`,
    });
  }

  const aspectDir = path.join(packageDir, SCAFFOLD_ASPECT);
  await atomicWriteFile(path.join(packageDir, PACKAGE_FILENAME), scaffoldPackageManifest(name, cliVersion()));
  await atomicWriteFile(path.join(aspectDir, 'yg-aspect.yaml'), scaffoldAspectYaml());
  await atomicWriteFile(path.join(aspectDir, 'check.mjs'), scaffoldCheckScript());
  // The directory name is `drills`, and the FIRST path segment of a case is what
  // says whether it must be refused or must pass — so the prefix is exactly
  // `violates-` or `satisfies-`, and a case file sits under it at any depth.
  await atomicWriteFile(
    path.join(aspectDir, 'drills', 'violates-marker-left-behind', 'src', 'thing.ts'),
    '// TODO: this line is what the rule must refuse.\nexport const a = 1;\n',
  );
  await atomicWriteFile(
    path.join(aspectDir, 'drills', 'satisfies-clean', 'src', 'thing.ts'),
    'export const a = 1;\n',
  );

  const manifestText = await readTextFile(manifestPath);
  await atomicWriteFile(manifestPath, withPackageEntry(manifestText, name, '0.1.0'));

  process.stdout.write(
    `\n${chalk.green('Package scaffolded')}: ${PACKAGES_DIR}/${name}\n\n` +
      `  ${PACKAGE_FILENAME.padEnd(36)}version, the Yggdrasil it needs, its rules and their settings\n` +
      `  ${`${SCAFFOLD_ASPECT}/yg-aspect.yaml`.padEnd(36)}one rule\n` +
      `  ${`${SCAFFOLD_ASPECT}/check.mjs`.padEnd(36)}what it refuses, reading ctx.config.${SCAFFOLD_CONFIG_KEY}\n` +
      `  ${`${SCAFFOLD_ASPECT}/drills/violates-…`.padEnd(36)}a case it must refuse\n` +
      `  ${`${SCAFFOLD_ASPECT}/drills/satisfies-…`.padEnd(36)}a case it must let through\n` +
      `\n${MARKETPLACE_FILENAME} now publishes '${name}' at 0.1.0.\n` +
      `Next: write the rule, run \`yg marketplace check\`, then tag it \`pack/${name}@0.1.0\`.\n\n`,
  );
}

// ============================================================
// The command
// ============================================================

export function registerPackCommand(program: Command): void {
  const pack = program
    .command('pack')
    .description(
      'Install rules published by another repository, keep them exactly as published, and adapt them ' +
        'in a file beside each copy. Installing a package runs its author\'s code on every check — ' +
        'install only from a source you trust that far.',
    );

  pack
    .command('new')
    .argument('<name>', 'the package to create, as one path segment')
    .description('Scaffold a package in this marketplace: a manifest, one rule, and the cases that prove it')
    .action(async (name: string) => {
      try {
        await runNew(name);
      } catch (error) {
        handleError(error);
      }
    });

  pack
    .command('add')
    .argument('<spec>', 'where to get it and what to take: <url-or-path>#<package>[@<version>]')
    .description('Copy a package of rules into this repository and record what every file hashed to')
    .option('--as <owner/repo>', 'who published it, when the source cannot say for itself')
    .action(async (spec: string, opts: { as?: string }) => {
      try {
        await runAdd(spec, opts);
      } catch (error) {
        handleError(error);
      }
    });

  pack
    .command('update')
    .argument('[name]', 'the package to update; omit to update every installed package')
    .description('Replace an installed copy with a newer version, leaving your adaptations untouched')
    .option('--to <version>', 'take this exact version instead of whatever the source currently publishes')
    .action(async (name: string | undefined, opts: { to?: string }) => {
      try {
        await runUpdate(name, opts);
      } catch (error) {
        handleError(error);
      }
    });

  pack
    .command('list')
    .description('What is installed, which version, and whether the copies are still untouched')
    .action(async () => {
      try {
        await runList();
      } catch (error) {
        handleError(error);
      }
    });

  pack
    .command('remove')
    .argument('<name>', 'the installed package to remove')
    .description('Delete an installed package\'s rules and its record')
    .action(async (name: string) => {
      try {
        await runRemove(name);
      } catch (error) {
        handleError(error);
      }
    });
}

// ============================================================
// add
// ============================================================

async function runAdd(rawSpec: string, opts: { as?: string }): Promise<void> {
  const projectRoot = process.cwd();
  const graph = await loadGraphOrAbort(projectRoot, { tolerateInvalidConfig: true });

  const spec = parsePackageSpec(rawSpec);
  if (spec === null) {
    failWith({
      what: `'${rawSpec}' does not say which package to take.`,
      why: 'A source can publish several packages, so the name is part of what you ask for.',
      next: 'Run: yg pack add <url-or-path>#<package>   (add @<version> to pin one).',
    });
  }

  if (opts.as !== undefined && !validIdentity(opts.as)) {
    failWith({
      what: `--as '${opts.as}' is not an <owner>/<repo>.`,
      why: 'The identity becomes the directory the package is installed under, so it is exactly two plain path segments.',
      next: 'Re-run with --as <owner>/<repo>, e.g. --as acme/law.',
    });
  }

  const lock = await readLock(projectRoot);
  if (Object.prototype.hasOwnProperty.call(lock.packages, spec.name)) {
    const installed = lock.packages[spec.name];
    // Refused rather than quietly reinstalled. A second `add` would overwrite the
    // copy, and someone typing it usually means "get the newer one" — which is a
    // different command, one that checks the copy is untouched first and keeps the
    // adaptations. Doing that silently under `add` would throw away an edit
    // without ever saying so.
    failWith({
      what: `'${spec.name}' is already installed (version ${installed.version}, from ${installed.source}).`,
      why: 'Installing again would overwrite the copy that is there and the record of what it hashed to.',
      next: `To take a newer version, run: yg pack update ${spec.name}. To start over, run yg pack remove ${spec.name} first.`,
    });
  }

  const identity = await resolveIdentity(spec.source, opts.as);
  const fetched = await fetchSource(projectRoot, spec.source, spec.name, spec.version);
  try {
    const entry = await readMarketplaceEntry(fetched.rootAbs, spec.name);
    const { manifest, packageRootAbs } = await readPackage(fetched.rootAbs, entry);

    const installId = `${identity}/${manifest.name}`;
    const idPrefix = `${PACKAGES_DIR}/${installId}`;
    for (const aspectDir of manifest.aspects) {
      const id = `${idPrefix}/${aspectDir}`;
      if (graph.aspects.some((a) => a.id === id)) {
        failWith({
          what: `Installing '${manifest.name}' would bring in a rule called '${id}', and this repository already has one by that name.`,
          why: 'Two rules under one id cannot both be attached, checked or recorded — whichever loaded second would silently take the other\'s place.',
          next: `Remove or rename the existing rule at .yggdrasil/aspects/${id}, or install this package under a different identity with --as <owner>/<repo>.`,
        });
      }
    }

    const result = await installPackage({
      projectRoot,
      installId,
      packageRootAbs,
      manifest,
      source: spec.source,
      installedAt: new Date().toISOString(),
      currentLock: lock,
    });
    if (!result.ok) failWith(result.messageData);

    const fileCount = Object.keys(result.value.files).length;
    process.stdout.write(
      chalk.green(
        `Installed '${manifest.name}' ${manifest.version} into .yggdrasil/aspects/${installDirRelative(installId)}/ ` +
          `(${manifest.aspects.length} ${manifest.aspects.length === 1 ? 'rule' : 'rules'}, ${fileCount} ${fileCount === 1 ? 'file' : 'files'}).\n`,
      ),
    );
    for (const aspectDir of manifest.aspects) {
      process.stdout.write(`  ${idPrefix}/${aspectDir}\n`);
    }
    process.stdout.write(
      '\nAttach a rule to a component by its full name above. Do not edit the copied files — ' +
        `change a rule in the ${ADAPT_FILENAME} written beside it.\n` +
        chalk.yellow(
          'These rules run their author\'s code in this process on every check. Only what they read is fenced, not what they run.\n',
        ),
    );
    await exitAfterFlush(0);
  } finally {
    if (fetched.cleanup !== undefined) await removeDirectory(fetched.cleanup);
  }
}

/**
 * Who published this. From `--as` when given, otherwise from the URL, otherwise
 * from what a local checkout says its origin is.
 *
 * A local directory that is not a checkout, or has no origin, has nothing to go
 * on — and guessing (the directory's own name, say) would let two unrelated
 * copies install over each other. So it asks.
 */
async function resolveIdentity(source: string, asOption: string | undefined): Promise<string> {
  if (asOption !== undefined) return asOption;

  if (isLocalDirectory(source)) {
    const origin = await readOriginUrl(source);
    const fromOrigin = origin === null ? null : identityFromUrl(origin);
    if (fromOrigin !== null && validIdentity(fromOrigin)) return fromOrigin;
    failWith({
      what: `Cannot tell who published the package at '${source}'.`,
      why: 'A package is installed under the identity of the repository it came from, so two sources publishing the same name never collide. A local directory with no git origin says nothing about whose it is, and guessing from the directory name would let two unrelated packages overwrite each other.',
      next: 'Re-run with --as <owner>/<repo> to say who it is.',
    });
  }

  const fromUrl = identityFromUrl(source);
  if (fromUrl !== null && validIdentity(fromUrl)) return fromUrl;
  failWith({
    what: `Cannot read an <owner>/<repo> out of '${source}'.`,
    why: 'A package is installed under the identity of the repository it came from, and this source does not carry one.',
    next: 'Re-run with --as <owner>/<repo> to say who it is.',
  });
}

// ============================================================
// update
// ============================================================

async function runUpdate(name: string | undefined, opts: { to?: string }): Promise<void> {
  const projectRoot = process.cwd();
  const graph = await loadGraphOrAbort(projectRoot, { tolerateInvalidConfig: true });

  const lock = await readLock(projectRoot);
  const names = name === undefined ? Object.keys(lock.packages).sort() : [name];

  if (names.length === 0) {
    process.stdout.write('No packages are installed.\n');
    await exitAfterFlush(0);
    return;
  }
  if (name !== undefined && !Object.prototype.hasOwnProperty.call(lock.packages, name)) {
    failWith({
      what: `'${name}' is not installed.`,
      why: 'Only a package this repository already holds can be updated.',
      next: 'Run yg pack list to see what is installed.',
    });
  }
  if (opts.to !== undefined && names.length > 1) {
    failWith({
      what: '--to names one version, but no package was named.',
      why: 'A single version cannot mean anything across several packages at once.',
      next: 'Run: yg pack update <name> --to <version>.',
    });
  }

  const drift = await collectPackagesDrift(projectRoot, lock);
  let changed = 0;
  // Refreshed alongside the update, for the same reason a listing refreshes it:
  // this command already reaches the source, and asking it one more question
  // while it is answering costs nothing — where the attention feed asking for
  // itself would cost the guarantee that it never leaves the repository.
  const observed: Record<string, string[]> = {};
  let anyReached = false;

  for (const pkgName of names) {
    const entry = lock.packages[pkgName];
    const packageDrift = drift.byPackage.get(pkgName);
    if (!isCopyIntact(packageDrift)) {
      const touched = [...(packageDrift?.modified ?? []), ...(packageDrift?.missing ?? [])]
        .sort((a, b) => (a < b ? -1 : 1))
        .map((f) => `  ${repoRelativePackagePath(f)}`)
        .join('\n');
      failWith({
        what: `The copy of '${pkgName}' has been changed since it was installed:\n${touched}`,
        why: 'An update replaces every file the package installed, so those changes would be gone with nothing recording that they existed. Nothing was updated.',
        next: `Restore the files listed above and put your changes in the ${ADAPT_FILENAME} beside each rule, which an update leaves alone. Then run this again.`,
      });
    }

    const tags = await listPackageVersionTags(entry.source, pkgName);
    if (tags !== null) {
      observed[pkgName] = tags;
      anyReached = true;
    }

    const fetched = await fetchSource(projectRoot, entry.source, pkgName, opts.to);
    try {
      const marketEntry = await readMarketplaceEntry(fetched.rootAbs, pkgName);
      const { manifest, packageRootAbs } = await readPackage(fetched.rootAbs, marketEntry);

      if (opts.to === undefined && manifest.version === entry.version) {
        process.stdout.write(`'${pkgName}' is already at ${entry.version}.\n`);
        continue;
      }

      // The consumer's adaptations are read off the current install and written
      // back into the new copy verbatim. That is the whole contract of adapting
      // beside the copy: the rule is replaced, the tuning survives, byte for byte.
      const preserveAdapts = await readInstalledAdapts(projectRoot, entry.package, manifest.aspects);

      const result = await installPackage({
        projectRoot,
        installId: entry.package,
        packageRootAbs,
        manifest,
        source: entry.source,
        installedAt: new Date().toISOString(),
        currentLock: await readLock(projectRoot),
        preserveAdapts,
      });
      if (!result.ok) failWith(result.messageData);

      changed += 1;
      process.stdout.write(chalk.green(`Updated '${pkgName}' ${entry.version} → ${manifest.version}.\n`));
    } finally {
      if (fetched.cleanup !== undefined) await removeDirectory(fetched.cleanup);
    }
  }

  await rememberObservedVersions(graph.rootPath, observed, anyReached);

  if (changed > 0) {
    process.stdout.write(
      '\nRules whose content changed need judging again. Run: yg check --approve\n',
    );
  }
  await exitAfterFlush(0);
}

// ============================================================
// list
// ============================================================

async function runList(): Promise<void> {
  const projectRoot = process.cwd();
  const graph = await loadGraphOrAbort(projectRoot, { tolerateInvalidConfig: true });

  const lock = await readLock(projectRoot);
  const names = Object.keys(lock.packages).sort((a, b) => (a < b ? -1 : 1));
  if (names.length === 0) {
    process.stdout.write(
      `No packages installed.\n\nInstall one with: yg pack add <url-or-path>#<package>\n`,
    );
    await exitAfterFlush(0);
    return;
  }

  const drift = await collectPackagesDrift(projectRoot, lock);
  process.stdout.write(`${names.length} installed:\n\n`);
  for (const name of names) {
    const entry = lock.packages[name];
    const intact = isCopyIntact(drift.byPackage.get(name));
    process.stdout.write(
      `  ${name}  ${entry.version}  ${intact ? chalk.green('copy untouched') : chalk.red('copy changed')}\n` +
        `    from ${entry.source}\n` +
        `    at   .yggdrasil/aspects/${installDirRelative(entry.package)}/\n`,
    );
  }

  const stale = names.filter((n) => !isCopyIntact(drift.byPackage.get(n)));
  if (stale.length > 0) {
    process.stdout.write(
      chalk.red(
        `\nA changed copy no longer runs what its package published, and yg check refuses it. ` +
          `Restore the files and adapt in ${ADAPT_FILENAME} instead.\n`,
      ),
    );
  }

  // A newer version, when the source can be reached. Unreachable is silence,
  // never a claim in either direction.
  //
  // What a reachable source says is also RECORDED, and that is why this is the
  // place the question gets asked. The attention feed wants to mention a newer
  // version, but it is run by an agent every session and every other signal in
  // it is derived from this repository alone — so it reads what was recorded
  // here rather than reaching out itself. Asking about packages is what a person
  // does when they run this command.
  const observed: Record<string, string[]> = {};
  let anyReached = false;
  for (const name of names) {
    const entry = lock.packages[name];
    const tags = await listPackageVersionTags(entry.source, name);
    if (tags === null) continue;
    anyReached = true;
    observed[name] = tags;
    const newer = newerThanInstalled(tags, entry.version);
    if (newer.length > 0) {
      process.stdout.write(`\n'${name}' also publishes: ${newer.join(', ')}\n`);
    }
  }
  await rememberObservedVersions(graph.rootPath, observed, anyReached);

  await exitAfterFlush(0);
}


/**
 * Write down what a reachable source said it publishes, so the attention feed
 * can mention a newer version without reaching outside the repository itself.
 *
 * Best-effort, deliberately: this rides on commands whose real job is something
 * else, and a cache that cannot be written (a read-only checkout, a full disk)
 * must not turn one of them into a failure — the reader already has the answer
 * on their screen, and the next run writes it again.
 */
async function rememberObservedVersions(
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
// remove
// ============================================================

async function runRemove(name: string): Promise<void> {
  const projectRoot = process.cwd();
  const graph = await loadGraphOrAbort(projectRoot, { tolerateInvalidConfig: true });

  const lock = await readLock(projectRoot);
  if (!Object.prototype.hasOwnProperty.call(lock.packages, name)) {
    failWith({
      what: `'${name}' is not installed.`,
      why: 'Only a package this repository holds can be removed.',
      next: 'Run yg pack list to see what is installed.',
    });
  }
  const entry = lock.packages[name];
  const idPrefix = `${PACKAGES_DIR}/${entry.package}`;

  const attached = attachmentsOf(graph, idPrefix);
  if (attached.nodes.length > 0 || attached.types.length > 0 || attached.flows.length > 0) {
    const lines = [
      ...attached.nodes.map((n) => `  component ${n}  (.yggdrasil/model/${n}/yg-node.yaml)`),
      ...attached.types.map((t) => `  type ${t}  (.yggdrasil/yg-architecture.yaml)`),
      ...attached.flows.map((f) => `  flow ${f}`),
    ].join('\n');
    failWith({
      what: `'${name}' is still in use:\n${lines}`,
      why: 'Removing its rules while something still names them would leave the graph pointing at law that is no longer there, and every check would fail on the dangling names rather than on anything real. Nothing was removed.',
      next: 'Detach the rules from everything listed above, then run this again.',
    });
  }

  await removePackageFiles(projectRoot, entry.package);
  const rest = { ...lock.packages };
  delete rest[name];
  await writePackagesLock(projectRoot, { schema: 'yg-packages/1', packages: rest });

  process.stdout.write(
    chalk.green(`Removed '${name}' — its rules and its record are gone.\n`),
  );
  if (Object.keys(rest).length === 0) {
    process.stdout.write(`.yggdrasil/${PACKAGES_LOCK_FILENAME} now records nothing installed.\n`);
  }
  await exitAfterFlush(0);
}
