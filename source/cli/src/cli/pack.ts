import type { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { parseDocument, isSeq } from 'yaml';

import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { findUpwards } from './marketplace.js';
import { atomicWriteFile } from '../io/atomic-write.js';
import { readTextFile } from '../io/graph-fs.js';
import { toPosixPath } from '../utils/posix.js';
import { exitAfterFlush } from './exit-after-flush.js';
import { debugWrite } from '../utils/debug-log.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import {
  ADAPT_FILENAME,
  MARKETPLACE_FILENAME,
  PACKAGE_FILENAME,
  PACKAGES_DIR,
  PACKAGES_LOCK_FILENAME,
  REQUESTED_LATEST,
} from '../model/packages.js';
import { parseMarketplaceManifest } from '../io/package-manifest-parser.js';
import {
  PackCommandBusyError,
  hashPackageTree,
  installPackage,
  installDirRelative,
  readInstalledAdapts,
  removePackageFiles,
  writePackagesLock,
} from '../io/package-store.js';
import { collectPackagesDrift, isCopyIntact, repoRelativePackagePath } from '../core/checks/packages.js';
import { newerThanInstalled } from '../core/advise-package-nominations.js';
import {
  FetchSession,
  PackRefusal,
  assertVersionsAgree,
  attachmentsOf,
  differingFiles,
  failWith,
  installedRuleDirs,
  isLocalDirectory,
  ownerRepoOf,
  parsePackageSpec,
  projectRootOf,
  readLock,
  readMarketplaceEntry,
  readPackage,
  recordableSource,
  rememberObservedVersions,
  resolveIdentity,
  resolveRecordedSource,
  resolveTypedSource,
  shortCommit,
  sourceKindOf,
  validIdentity,
  withCommandLock,
} from './pack-source.js';
import { runUpdate } from './pack-update.js';
import type { UpdateOptions } from './pack-update.js';
import { cliVersion } from './cli-version.js';

/**
 * `yg pack` — install law published by someone else, keep it as they published
 * it, and adapt it beside the copy.
 *
 * There is no registry and no resolver. A marketplace is an ordinary git
 * repository with a manifest at its root; a package inside it is a directory of
 * ordinary rules. A VERSION is a tag, `pack/<name>@<version>`: `add` takes the
 * newest one (or the one named), copies the package in from exactly that tag, and
 * records the tag, the commit it pointed at, and what every file hashed to.
 * `update` replaces the copy with another published version and leaves your
 * adaptation alone; `list` says what is installed and whether the copies are
 * untouched; `verify` asks the source whether the copy is still what it
 * published; `remove` takes one back out.
 *
 * The copy is never edited. Everything a repository wants different goes in the
 * `yg-aspect.adapt.yaml` written beside each installed rule, which is what lets an
 * update be a replacement rather than a merge.
 *
 * Every command works on the repository the graph belongs to, wherever inside it
 * it is run — the project root is the graph's parent, never the working
 * directory. A path on this machine the user types is resolved from where they
 * typed it and recorded relative to the repository.
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

/**
 * Run one subcommand and exit with what it returned — or with 1 and the refusal,
 * printed once the command's own cleanup has run.
 */
async function runPackAction(body: () => Promise<number>): Promise<void> {
  let code: number;
  try {
    code = await body();
  } catch (error) {
    if (error instanceof PackRefusal || error instanceof PackCommandBusyError) {
      debugWrite(`[pack] command refused: ${error.message}`);
    }
    if (error instanceof PackRefusal) {
      process.stderr.write(chalk.red(`Error: ${buildIssueMessage(error.messageData)}`) + '\n');
      code = 1;
    } else if (error instanceof PackCommandBusyError) {
      process.stderr.write(
        chalk.red(
          `Error: ${buildIssueMessage({
            what: `Another yg pack command${error.holderPid === null ? '' : ` (process ${error.holderPid})`} is changing this repository's packages right now.`,
            why: `Two commands changing .yggdrasil/${PACKAGES_LOCK_FILENAME} at once would each write back the record they read, and one package would silently drop out of it. Nothing was changed.`,
            next: `Wait for it to finish and run this again. If no pack command is running, delete ${toPosixPath(error.lockPath)} and run this again.`,
          })}`,
        ) + '\n',
      );
      code = 1;
    } else {
      handleError(error);
    }
  }
  await exitAfterFlush(code);
}

// ============================================================
// Parsing what the user asked for
// ============================================================

/** The one aspect directory a scaffolded package starts with. */
const SCAFFOLD_ASPECT = 'example';

/** The setting that aspect reads — deliberately the same word, so the pairing is obvious. */
const SCAFFOLD_CONFIG_KEY = 'example';

/**
 * The package manifest a new package starts from.
 *
 * `requires.yg` is pinned to the running MAJOR — `^<major>.0.0` — rather than to
 * this exact build: a package written today against 6.1 works on 6.4, and a range
 * naming the patch would refuse consumers for no reason. It is NOT open-ended: a
 * next major may change the graph format the rules are written in, so a consumer
 * on it is told to find a release built for it rather than install one that may
 * not load. The version starts at 0.1.0 — publishing is tagging, and the author
 * decides when the first real number is.
 */
export function scaffoldPackageManifest(name: string, version: string): string {
  const major = version.split('.')[0];
  return [
    `schema: yg-package/1`,
    `name: ${name}`,
    `version: 0.1.0`,
    `requires:`,
    `  yg: "^${major}.0.0"`,
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

async function runNew(rawName: string): Promise<number> {
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
  return 0;
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
      await runPackAction(() => runNew(name));
    });

  pack
    .command('add')
    .argument('<spec>', 'where to get it and what to take: <url-or-path>#<package>[@<version>]')
    .description('Copy a published version of a package into this repository and record the tag, commit and file hashes')
    .option('--as <owner/repo>', 'who published it, when the source cannot say for itself')
    .action(async (spec: string, opts: { as?: string }) => {
      await runPackAction(() => runAdd(spec, opts));
    });

  pack
    .command('update')
    .argument('[name]', 'the package to update; omit to update every installed package')
    .description('Replace an installed copy with another published version, leaving your adaptations untouched')
    .option('--to <version>', "take this exact version and pin it, or 'latest' to follow the newest again")
    .option('--allow-downgrade', 'with --to, allow a version older than the one installed')
    .option('--reinstall', 'restore an edited or incomplete copy from the version the record names, keeping your adaptations')
    .action(async (name: string | undefined, opts: UpdateOptions) => {
      await runPackAction(() => runUpdate(name, opts));
    });

  pack
    .command('list')
    .description('What is installed, which version, and whether the copies are still untouched')
    .action(async () => {
      await runPackAction(() => runList());
    });

  pack
    .command('verify')
    .argument('[name]', 'the package to verify; omit to verify every installed package')
    .description('Ask each source whether the installed copy is still exactly what it published under the recorded tag')
    .action(async (name: string | undefined) => {
      await runPackAction(() => runVerify(name));
    });

  pack
    .command('remove')
    .argument('<name>', 'the installed package to remove')
    .description('Delete an installed package\'s rules, their adaptations, and its record')
    .action(async (name: string) => {
      await runPackAction(() => runRemove(name));
    });
}

async function runAdd(rawSpec: string, opts: { as?: string }): Promise<number> {
  const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
  const projectRoot = projectRootOf(graph);

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

  return withCommandLock(projectRoot, async () => {
    const lock = await readLock(projectRoot);
    const resolved = resolveTypedSource(spec.source);
    const identity = await resolveIdentity(resolved, opts.as, spec.source);

    if (Object.prototype.hasOwnProperty.call(lock.packages, spec.name)) {
      const installed = lock.packages[spec.name];
      if (ownerRepoOf(installed.package) === identity) {
        // Refused rather than quietly reinstalled. A second `add` would overwrite
        // the copy, and someone typing it usually means "get the newer one" —
        // which is a different command, one that checks the copy is untouched
        // first and keeps the adaptations.
        failWith({
          what: `'${spec.name}' is already installed (version ${installed.version}, from ${installed.source}).`,
          why: 'Installing again would overwrite the copy that is there and the record of what it hashed to.',
          next: `To take another version, run: yg pack update ${spec.name} --to <version>. To repair an edited copy, run: yg pack update ${spec.name} --reinstall. To start over, run yg pack remove ${spec.name} first.`,
        });
      }
      failWith({
        what: `A package named '${spec.name}' is already installed from ${ownerRepoOf(installed.package)} (version ${installed.version}); this one is published by ${identity}.`,
        why: `The package record, .yggdrasil/${PACKAGES_LOCK_FILENAME}, is keyed by the package's name, and every pack command addresses a package by that name — so a repository holds one package of a given name at a time. Nothing was installed or changed.`,
        next: `Keep the one you have, or run yg pack remove ${spec.name} and install this one instead.`,
      });
    }

    const kind = await sourceKindOf(resolved);
    const session = new FetchSession(projectRoot);
    try {
      const fetched = await session.fetch(
        resolved,
        kind,
        spec.name,
        spec.version === undefined ? { kind: 'latest' } : { kind: 'exact', version: spec.version },
      );
      const entry = await readMarketplaceEntry(fetched.rootAbs, spec.name);
      const { manifest, packageRootAbs } = await readPackage(fetched.rootAbs, entry);
      assertVersionsAgree(fetched, entry, manifest);

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

      const recorded = recordableSource(resolved, projectRoot);
      const result = await installPackage({
        projectRoot,
        installId,
        packageRootAbs,
        manifest,
        source: recorded.source,
        installedAt: new Date().toISOString(),
        currentLock: lock,
        provenance: {
          requested: spec.version ?? REQUESTED_LATEST,
          ...(fetched.tag !== undefined && { tag: fetched.tag }),
          ...(fetched.commit !== undefined && { commit: fetched.commit }),
          ...(opts.as !== undefined && { identity: 'given' as const }),
        },
      });
      if (!result.ok) failWith(result.messageData);

      const fileCount = Object.keys(result.value.files).length;
      const from = fetched.tag === undefined ? '' : ` from ${fetched.tag} (commit ${shortCommit(fetched.commit)})`;
      process.stdout.write(
        chalk.green(
          `Installed '${manifest.name}' ${manifest.version}${from} into .yggdrasil/aspects/${installDirRelative(installId)}/ ` +
            `(${manifest.aspects.length} ${manifest.aspects.length === 1 ? 'rule' : 'rules'}, ${fileCount} ${fileCount === 1 ? 'file' : 'files'}).\n`,
        ),
      );
      for (const aspectDir of manifest.aspects) {
        process.stdout.write(`  ${idPrefix}/${aspectDir}\n`);
      }
      if (spec.version !== undefined) {
        process.stdout.write(`\nPinned at ${spec.version}: yg pack update leaves it there until you move it with --to.\n`);
      }
      if (kind === 'directory') {
        process.stdout.write(
          chalk.yellow(
            `\n'${toPosixPath(resolved.location)}' is a plain directory, not a git repository, so there was no published version to take: ` +
              'its files were copied as they are on disk, and the record names no tag or commit. ' +
              'Install from the marketplace repository to get a version others can reproduce.\n',
          ),
        );
      }
      if (recorded.strippedCredentials) {
        process.stdout.write(
          chalk.yellow(`\nThe credentials written into the URL were not recorded; the record names ${recorded.source}. Give git a credential helper instead.\n`),
        );
      }
      process.stdout.write(
        '\nAttach a rule to a component by its full name above. Do not edit the copied files — ' +
          `change a rule in the ${ADAPT_FILENAME} written beside it.\n` +
          chalk.yellow(
            'These rules run their author\'s code in this process on every check. Only what they read is fenced, not what they run.\n',
          ),
      );
      if (fetched.published !== null) {
        await rememberObservedVersions(graph.rootPath, { [manifest.name]: fetched.published }, true);
      }
      return 0;
    } finally {
      await session.cleanup();
    }
  });
}

async function runList(): Promise<number> {
  const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
  const projectRoot = projectRootOf(graph);

  const lock = await readLock(projectRoot);
  const names = Object.keys(lock.packages).sort((a, b) => (a < b ? -1 : 1));
  if (names.length === 0) {
    process.stdout.write(`No packages installed.\n\nInstall one with: yg pack add <url-or-path>#<package>\n`);
    return 0;
  }

  const drift = await collectPackagesDrift(projectRoot, lock);
  process.stdout.write(`${names.length} installed:\n\n`);
  for (const name of names) {
    const entry = lock.packages[name];
    const intact = isCopyIntact(drift.byPackage.get(name));
    const requested = entry.requested ?? REQUESTED_LATEST;
    const provenance =
      entry.tag !== undefined
        ? `${entry.tag}, commit ${shortCommit(entry.commit)}`
        : 'no tag recorded — read from a plain directory, or installed by an earlier release';
    process.stdout.write(
      `  ${name}  ${entry.version}  ${requested === REQUESTED_LATEST ? 'follows the newest version' : `pinned at ${requested}`}  ` +
        `${intact ? chalk.green('copy untouched') : chalk.red('copy changed')}\n` +
        `    from ${entry.source}  (${provenance})\n` +
        `    at   .yggdrasil/aspects/${installDirRelative(entry.package)}/\n`,
    );
  }

  const stale = names.filter((n) => !isCopyIntact(drift.byPackage.get(n)));
  if (stale.length > 0) {
    process.stdout.write(
      chalk.red(
        `\nA changed copy no longer runs what its package published, and yg check refuses it. ` +
          `Put your change in ${ADAPT_FILENAME} instead, and restore the copy with: yg pack update <name> --reinstall\n`,
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
  // here rather than reaching out itself. Each source is asked once, however
  // many of its packages are installed.
  const session = new FetchSession(projectRoot);
  const observed: Record<string, string[]> = {};
  for (const name of names) {
    const entry = lock.packages[name];
    const resolved = resolveRecordedSource(entry.source, projectRoot);
    if (resolved.local && !isLocalDirectory(resolved.location)) continue;
    const tags = await session.versionsOf(resolved.location, name);
    if (tags === null) continue;
    observed[name] = tags;
    const newer = newerThanInstalled(tags, entry.version);
    if (newer.length > 0) {
      process.stdout.write(
        `\n'${name}' also publishes: ${newer.join(', ')}  — take one with: yg pack update ${name} --to ${newer[newer.length - 1]}\n`,
      );
    }
  }
  await rememberObservedVersions(graph.rootPath, observed, Object.keys(observed).length > 0);
  return 0;
}

/**
 * Ask each source whether the installed copy is still what it published.
 *
 * The record attests to itself — anyone who can change the committed record can
 * change it together with the copy — so the only independent answer is the
 * source's. Three questions per package: does the recorded tag still point at the
 * recorded commit, does what that tag holds hash to what the record says, and is
 * the copy on disk still what the record says. Any "no" exits 1.
 */
async function runVerify(name: string | undefined): Promise<number> {
  const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
  const projectRoot = projectRootOf(graph);

  return withCommandLock(projectRoot, async () => {
    const lock = await readLock(projectRoot);
    if (name !== undefined && !Object.prototype.hasOwnProperty.call(lock.packages, name)) {
      failWith({
        what: `'${name}' is not installed.`,
        why: 'Only a package this repository holds can be verified.',
        next: 'Run yg pack list to see what is installed.',
      });
    }
    const names = name === undefined ? Object.keys(lock.packages).sort() : [name];
    if (names.length === 0) {
      process.stdout.write('No packages are installed.\n');
      return 0;
    }

    const drift = await collectPackagesDrift(projectRoot, lock);
    const session = new FetchSession(projectRoot);
    let failed = 0;
    try {
      for (const pkgName of names) {
        const entry = lock.packages[pkgName];
        const problems: string[] = [];
        const packageDrift = drift.byPackage.get(pkgName);
        for (const f of packageDrift?.modified ?? []) problems.push(`${repoRelativePackagePath(f)} has been edited in this repository`);
        for (const f of packageDrift?.missing ?? []) problems.push(`${repoRelativePackagePath(f)} is missing in this repository`);

        let against = '';
        try {
          const resolved = resolveRecordedSource(entry.source, projectRoot);
          const kind = await sourceKindOf(resolved, pkgName);
          const tagVersion = entry.tag?.slice(`pack/${pkgName}@`.length) ?? entry.version;
          const fetched = await session.fetch(
            resolved,
            kind,
            pkgName,
            kind === 'directory' ? { kind: 'latest' } : { kind: 'exact', version: tagVersion },
          );
          const marketEntry = await readMarketplaceEntry(fetched.rootAbs, pkgName);
          const { packageRootAbs } = await readPackage(fetched.rootAbs, marketEntry);
          const now = await hashPackageTree(packageRootAbs, entry.package);
          if (!now.ok) failWith(now.messageData);
          if (entry.commit !== undefined && fetched.commit !== entry.commit) {
            problems.push(`${fetched.tag} now points at commit ${shortCommit(fetched.commit)}, not the recorded ${shortCommit(entry.commit)}`);
          }
          for (const f of differingFiles(entry.files, now.value)) {
            problems.push(`${repoRelativePackagePath(f)} is not what the source publishes${fetched.tag === undefined ? '' : ` under ${fetched.tag}`}`);
          }
          against =
            fetched.tag !== undefined
              ? `${fetched.tag} at commit ${shortCommit(fetched.commit)}${entry.commit === undefined ? ' (the record names no commit, so only the files were compared)' : ''}`
              : `the directory '${entry.source}' as it is now (it publishes no versions)`;
        } catch (err) {
          if (!(err instanceof PackRefusal)) throw err;
          debugWrite(`[pack] verify '${pkgName}': could not compare with its source: ${err.messageData.what}`);
          problems.push(`could not be compared with its source: ${err.messageData.what}`);
        }

        if (problems.length === 0) {
          process.stdout.write(chalk.green(`'${pkgName}' ${entry.version} — the copy is exactly ${against}.\n`));
        } else {
          failed += 1;
          process.stdout.write(chalk.red(`'${pkgName}' ${entry.version} does not verify:\n`) + problems.map((p) => `  ${p}\n`).join(''));
        }
      }
    } finally {
      await session.cleanup();
    }

    if (failed > 0) {
      process.stdout.write(
        `\nA copy that does not match its source is not what its publisher released. ` +
          `Restore an edited copy with yg pack update <name> --reinstall; ask the publisher about a tag that moved.\n`,
      );
      return 1;
    }
    return 0;
  });
}

// ============================================================
// remove
// ============================================================

async function runRemove(name: string): Promise<number> {
  const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
  const projectRoot = projectRootOf(graph);

  return withCommandLock(projectRoot, async () => {
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
    const own = new Set(graph.aspects.filter((a) => a.id.startsWith(`${idPrefix}/`)).map((a) => a.id));
    for (const rule of await installedRuleDirs(graph, projectRoot, entry)) own.add(`${idPrefix}/${rule}`);

    const attached = attachmentsOf(graph, own, idPrefix);
    if (attached.length > 0) {
      failWith({
        what: `'${name}' is still in use:\n${attached.map((a) => `  ${a.where}  → ${a.aspectId}`).join('\n')}`,
        why: 'Removing its rules while something still names them would leave the graph pointing at law that is no longer there, and every check would fail on the dangling names rather than on anything real. Nothing was removed.',
        next: 'Detach the rules from everything listed above, then run this again.',
      });
    }

    const adapted = (await readInstalledAdapts(projectRoot, entry.package, [...own].map((id) => id.slice(idPrefix.length + 1)))).size;
    await removePackageFiles(projectRoot, entry.package);
    const rest = { ...lock.packages };
    delete rest[name];
    await writePackagesLock(projectRoot, { schema: 'yg-packages/1', packages: rest });

    process.stdout.write(chalk.green(`Removed '${name}' — its rules and its record are gone.\n`));
    if (adapted > 0) {
      process.stdout.write(
        `Its ${adapted} ${adapted === 1 ? 'adaptation' : 'adaptations'} (${ADAPT_FILENAME}) went with it; version control still has ${adapted === 1 ? 'it' : 'them'}.\n`,
      );
    }
    if (Object.keys(rest).length === 0) {
      process.stdout.write(`.yggdrasil/${PACKAGES_LOCK_FILENAME} now records nothing installed.\n`);
    }
    return 0;
  });
}
