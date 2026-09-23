import chalk from 'chalk';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { lt as semverLt, valid as validSemver } from 'semver';

import { loadGraphOrAbort } from './preamble.js';
import { readTextFile } from '../io/graph-fs.js';
import { debugWrite } from '../utils/debug-log.js';
import type { IssueMessage } from '../model/validation.js';
import type { Graph } from '../model/graph.js';
import type { PackageManifest, PackagesLockEntry } from '../model/packages.js';
import { ADAPT_FILENAME, ADAPT_LOG_FILENAME, PACKAGE_FILENAME, PACKAGES_DIR, PACKAGES_LOCK_FILENAME, REQUESTED_LATEST } from '../model/packages.js';
import { parsePackageManifest } from '../io/package-manifest-parser.js';
import {
  hashPackageTree,
  installDirAbs,
  installDirRelative,
  installPackage,
  readInstalledAdapts,
  writePackagesLock,
} from '../io/package-store.js';
import { collectPackagesDrift, isCopyIntact, repoRelativePackagePath } from '../core/checks/packages.js';
import { newerThanInstalled } from '../core/advise-package-nominations.js';
import {
  FetchSession,
  assertVersionsAgree,
  attachmentsOf,
  deriveIdentity,
  differingFiles,
  failWith,
  installedRuleDirs,
  isLocalDirectory,
  ownerRepoOf,
  projectRootOf,
  readLock,
  readMarketplaceEntry,
  readPackage,
  rememberObservedVersions,
  resolveRecordedSource,
  shortCommit,
  sourceKindOf,
  withCommandLock,
} from './pack-source.js';
import type { Fetched, Want } from './pack-source.js';

/**
 * source/cli/src/cli/pack-update.ts — `yg pack update`: replace an installed
 * copy with another published version, or put an edited one back.
 *
 * Two phases. The first fetches, validates and judges EVERY package the run
 * names — drift, identity, the version asked for against the one installed, what
 * the new version would leave dangling in the graph — and writes nothing, so a
 * refusal anywhere in it truthfully says nothing was changed. The second applies,
 * one atomic swap per package, and a failure there reports exactly which
 * packages were already updated and which were not.
 *
 * A pin is a pin: a package installed at an exact version stays there until
 * `--to` moves it. Going back a version is refused unless `--to` names it and
 * `--allow-downgrade` says so. `--reinstall` restores the version the record
 * names, file for file, keeping the consumer's adaptations — the repair for a
 * copy that was edited or lost a file.
 */

export interface UpdateOptions {
  to?: string;
  allowDowngrade?: boolean;
  reinstall?: boolean;
}

/** What an update decided to do with one package, before anything was written. */
interface UpdatePlan {
  name: string;
  entry: PackagesLockEntry;
  action: 'install' | 'record' | 'none';
  /** Lines said about this package whatever happens. */
  notes: string[];
  /** For 'install': what to install and what it changes. */
  install?: {
    manifest: PackageManifest;
    packageRootAbs: string;
    fetched: Fetched;
    requested: string;
    summary: string[];
  };
  /** For 'record': the entry to write in place of the old one. */
  record?: PackagesLockEntry;
}

export async function runUpdate(name: string | undefined, opts: UpdateOptions): Promise<number> {
  const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
  const projectRoot = projectRootOf(graph);

  if (opts.reinstall === true && name === undefined) {
    failWith({
      what: '--reinstall restores one package, but no package was named.',
      why: 'A reinstall replaces a copy you may have edited; it is done to one package you named, never swept across all of them.',
      next: 'Run: yg pack update <name> --reinstall.',
    });
  }
  if (opts.reinstall === true && (opts.to !== undefined || opts.allowDowngrade === true)) {
    failWith({
      what: '--reinstall cannot be combined with --to or --allow-downgrade.',
      why: 'A reinstall puts back exactly the version the record names; choosing another version is what --to does, as a separate step.',
      next: 'Run the reinstall on its own, then move to another version with --to if you want one.',
    });
  }
  if (opts.allowDowngrade === true && opts.to === undefined) {
    failWith({
      what: '--allow-downgrade needs --to <version>.',
      why: 'A downgrade is only ever taken to a version you named; an update without --to only moves forward.',
      next: 'Run: yg pack update <name> --to <version> --allow-downgrade.',
    });
  }
  if (opts.to !== undefined && name === undefined) {
    failWith({
      what: '--to names one version, but no package was named.',
      why: 'A single version cannot mean anything across several packages at once.',
      next: 'Run: yg pack update <name> --to <version>.',
    });
  }

  return withCommandLock(projectRoot, async () => {
    const lock = await readLock(projectRoot);
    const names = name === undefined ? Object.keys(lock.packages).sort() : [name];
    if (names.length === 0) {
      process.stdout.write('No packages are installed.\n');
      return 0;
    }
    if (name !== undefined && !Object.prototype.hasOwnProperty.call(lock.packages, name)) {
      failWith({
        what: `'${name}' is not installed.`,
        why: 'Only a package this repository already holds can be updated.',
        next: 'Run yg pack list to see what is installed.',
      });
    }

    // Every package this run would touch is judged for drift HERE, in one pass,
    // before a single file is replaced — so a refusal can truthfully say nothing
    // was changed. A reinstall is the one exception: an edited or incomplete copy
    // is exactly what it exists to repair.
    if (opts.reinstall !== true) {
      const drift = await collectPackagesDrift(projectRoot, lock);
      const drifted = names.filter((pkgName) => !isCopyIntact(drift.byPackage.get(pkgName)));
      if (drifted.length > 0) {
        const listed = drifted
          .map((pkgName) => {
            const packageDrift = drift.byPackage.get(pkgName);
            const touched = [...(packageDrift?.modified ?? []), ...(packageDrift?.missing ?? [])]
              .sort((a, b) => (a < b ? -1 : 1))
              .map((f) => `  ${repoRelativePackagePath(f)}`)
              .join('\n');
            return `The copy of '${pkgName}' has been changed since it was installed:\n${touched}`;
          })
          .join('\n');
        failWith({
          what: listed,
          why: 'An update replaces every file the package installed, so those changes would be gone with nothing recording that they existed. Nothing was updated — not this package and not any other, however many were named.',
          next: `Put your changes in the ${ADAPT_FILENAME} beside each rule, which an update leaves alone. To put the copy back as it was installed, run: yg pack update ${drifted[0]} --reinstall. Then run this again.`,
        });
      }
    }

    const session = new FetchSession(projectRoot);
    try {
      // Phase one: fetch, validate and judge EVERY package before anything is
      // written. A refusal anywhere here leaves every package as it was, so the
      // "nothing was changed" it prints is true.
      const plans: UpdatePlan[] = [];
      for (const pkgName of names) {
        plans.push(await planUpdate(graph, projectRoot, session, pkgName, lock.packages[pkgName], opts));
      }

      // Phase two: apply. Each package is its own atomic swap; a failure here is
      // reported for exactly what it is — what was already applied, what was not.
      let current = lock;
      const applied: string[] = [];
      let failure: { name: string; message: IssueMessage } | null = null;
      for (const plan of plans) {
        for (const note of plan.notes) process.stdout.write(`${note}\n`);
        if (plan.action === 'none') continue;
        if (plan.action === 'record' && plan.record !== undefined) {
          current = { schema: 'yg-packages/1', packages: { ...current.packages, [plan.name]: plan.record } };
          await writePackagesLock(projectRoot, current);
          continue;
        }
        const install = plan.install!;
        const result = await installPackage({
          projectRoot,
          installId: plan.entry.package,
          packageRootAbs: install.packageRootAbs,
          manifest: install.manifest,
          source: plan.entry.source,
          installedAt: new Date().toISOString(),
          currentLock: current,
          provenance: {
            requested: install.requested,
            ...(install.fetched.tag !== undefined && { tag: install.fetched.tag }),
            ...(install.fetched.commit !== undefined && { commit: install.fetched.commit }),
            ...(plan.entry.identity !== undefined && { identity: plan.entry.identity }),
          },
          // The consumer's adaptations and rule histories are read off the current
          // install and written into the new copy verbatim: the rule is replaced,
          // the tuning and its history survive, byte for byte.
          preserveAdapts: await readInstalledAdapts(projectRoot, plan.entry.package, install.manifest.aspects),
          preserveAdaptLogs: await readInstalledAdapts(projectRoot, plan.entry.package, install.manifest.aspects, ADAPT_LOG_FILENAME),
        });
        if (!result.ok) {
          failure = { name: plan.name, message: result.messageData };
          break;
        }
        current = { schema: 'yg-packages/1', packages: { ...current.packages, [plan.name]: result.value } };
        applied.push(plan.name);
        const verb = opts.reinstall === true ? 'Reinstalled' : 'Updated';
        const change = opts.reinstall === true ? plan.entry.version : `${plan.entry.version} → ${install.manifest.version}`;
        const from = install.fetched.tag === undefined ? '' : ` (${install.fetched.tag}, commit ${shortCommit(install.fetched.commit)})`;
        process.stdout.write(chalk.green(`${verb} '${plan.name}' ${change}${from}.\n`));
        for (const line of install.summary) process.stdout.write(`${line}\n`);
      }

      const observed: Record<string, string[]> = {};
      for (const pkgName of names) {
        const entry = lock.packages[pkgName];
        const resolved = resolveRecordedSource(entry.source, projectRoot);
        if (resolved.local && !isLocalDirectory(resolved.location)) continue;
        const all = await session.publishedBy(resolved.location);
        if (all !== null) observed[pkgName] = all.get(pkgName) ?? [];
      }
      await rememberObservedVersions(graph.rootPath, observed, Object.keys(observed).length > 0);

      if (applied.length > 0) {
        process.stdout.write('\nRules whose content changed need judging again. Run: yg check --approve\n');
      }
      if (failure !== null) {
        const notReached = plans
          .filter((p) => p.action === 'install' && !applied.includes(p.name) && p.name !== failure!.name)
          .map((p) => `'${p.name}'`);
        failWith({
          what: `'${failure.name}' could not be updated. ${failure.message.what}`,
          why: `${failure.message.why} ${applied.length === 0 ? 'No package was changed.' : `Already updated before this: ${applied.map((n) => `'${n}'`).join(', ')} — those changes stand.`}${notReached.length === 0 ? '' : ` Not attempted: ${notReached.join(', ')}.`}`,
          next: failure.message.next,
        });
      }
      return 0;
    } finally {
      await session.cleanup();
    }
  });
}

/** Decide, without writing anything, what an update does with one package. */
async function planUpdate(
  graph: Graph,
  projectRoot: string,
  session: FetchSession,
  pkgName: string,
  entry: PackagesLockEntry,
  opts: UpdateOptions,
): Promise<UpdatePlan> {
  const resolved = resolveRecordedSource(entry.source, projectRoot);
  const kind = await sourceKindOf(resolved, pkgName);

  // The record attests to itself: its source can be pointed somewhere else and
  // an update would then fetch that somewhere else's code under the name this
  // repository already trusts. Where the source says who it is, it has to say the
  // same thing the record does.
  if (entry.identity !== 'given') {
    const derived = await deriveIdentity(resolved);
    const recorded = ownerRepoOf(entry.package);
    if (derived !== null && derived !== recorded) {
      failWith({
        what: `The record says '${pkgName}' is published by ${recorded}, but its source '${entry.source}' is ${derived}'s.`,
        why: `An update fetches code from the recorded source and runs it under the identity already installed. A source that no longer matches that identity would swap in someone else's rules under a name this repository trusts. Nothing was updated.`,
        next: `If the package really moved, run yg pack remove ${pkgName} and install it again from its new source. Otherwise restore source: in .yggdrasil/${PACKAGES_LOCK_FILENAME} from version control.`,
      });
    }
  }

  const requestedNow = entry.requested ?? REQUESTED_LATEST;
  let want: Want;
  let requested = requestedNow;
  if (opts.reinstall === true) {
    const tagVersion = entry.tag?.slice(`pack/${pkgName}@`.length);
    want = kind === 'directory' ? { kind: 'latest' } : { kind: 'exact', version: tagVersion ?? entry.version };
  } else if (opts.to !== undefined) {
    requested = opts.to === REQUESTED_LATEST ? REQUESTED_LATEST : opts.to;
    want = opts.to === REQUESTED_LATEST ? { kind: 'latest' } : { kind: 'exact', version: opts.to };
  } else if (requestedNow !== REQUESTED_LATEST) {
    // A pin is a pin: a plain update leaves it where it was put, and says what
    // else is published so moving it is one command away.
    const published = kind === 'git' ? await session.versionsOf(resolved.location, pkgName) : null;
    const newer = published === null ? [] : newerThanInstalled(published, entry.version);
    return {
      name: pkgName,
      entry,
      action: 'none',
      notes: [
        `'${pkgName}' is pinned at ${entry.version}` +
          (newer.length === 0
            ? '; nothing newer is published.'
            : `; the source also publishes ${newer.join(', ')}. Move the pin with: yg pack update ${pkgName} --to ${newer[newer.length - 1]}  (or --to latest to follow the newest).`),
      ],
    };
  } else {
    want = { kind: 'latest' };
  }

  const fetched = await session.fetch(resolved, kind, pkgName, want);
  const marketEntry = await readMarketplaceEntry(fetched.rootAbs, pkgName);
  const { manifest, packageRootAbs } = await readPackage(fetched.rootAbs, marketEntry);
  assertVersionsAgree(fetched, marketEntry, manifest);

  const newHashes = await hashPackageTree(packageRootAbs, entry.package);
  if (!newHashes.ok) failWith(newHashes.messageData);

  if (opts.reinstall === true) {
    if (entry.commit !== undefined && fetched.commit !== entry.commit) {
      failWith({
        what: `The tag ${fetched.tag} of '${pkgName}' now points at commit ${shortCommit(fetched.commit)}, not ${shortCommit(entry.commit)}, the one this repository installed.`,
        why: 'A reinstall puts back exactly what was installed. The publisher has moved the tag since, so what it names today is not that — and taking it would swap code under a version number nobody changed. Nothing was changed.',
        next: `Ask the publisher why the tag moved. To take what it points at now, run yg pack remove ${pkgName} and install it again; git history holds the copy you had.`,
      });
    }
    const differs = differingFiles(entry.files, newHashes.value);
    if (differs.length > 0) {
      failWith({
        what: `What the source publishes as '${pkgName}' ${entry.version} today is not what this repository installed:\n${differs.map((f) => `  ${repoRelativePackagePath(f)}`).join('\n')}`,
        why: 'A reinstall puts back exactly what the record says was installed, file for file. The source no longer has that, so nothing could be put back faithfully. Nothing was changed.',
        next: `Restore the copy from version control instead (git checkout -- .yggdrasil/aspects/${installDirRelative(entry.package)}), or take a published version with yg pack update ${pkgName} --to <version>.`,
      });
    }
    return {
      name: pkgName,
      entry,
      action: 'install',
      notes: [],
      install: { manifest, packageRootAbs, fetched, requested: requestedNow, summary: [] },
    };
  }

  const installed = entry.version;
  const target = manifest.version;
  // A plain directory publishes no versions, so its number says nothing about
  // whether its files moved; there the files themselves are compared.
  const sameVersion =
    target === installed && (kind === 'git' || differingFiles(entry.files, newHashes.value).length === 0);
  if (sameVersion) {
    if (entry.commit !== undefined && fetched.commit !== undefined && entry.commit !== fetched.commit) {
      return {
        name: pkgName,
        entry,
        action: 'none',
        notes: [
          chalk.yellow(
            `'${pkgName}' is at ${installed}, but ${fetched.tag} now points at commit ${shortCommit(fetched.commit)}, not the recorded ${shortCommit(entry.commit)}. ` +
              `Nothing was changed. Run: yg pack verify ${pkgName}`,
          ),
        ],
      };
    }
    if (requested !== requestedNow) {
      return {
        name: pkgName,
        entry,
        action: 'record',
        record: { ...entry, requested },
        notes: [
          requested === REQUESTED_LATEST
            ? `'${pkgName}' stays at ${installed} and now follows the newest published version.`
            : `'${pkgName}' stays at ${installed}, now pinned there.`,
        ],
      };
    }
    return { name: pkgName, entry, action: 'none', notes: [`'${pkgName}' is already at ${installed}.`] };
  }

  if (validSemver(installed) !== null && semverLt(target, installed)) {
    if (opts.to === undefined || opts.to === REQUESTED_LATEST) {
      return {
        name: pkgName,
        entry,
        action: 'none',
        notes: [
          `'${pkgName}' is at ${installed}; the newest version its source publishes is ${target}, which is older. ` +
            `Nothing was changed. To go back to it: yg pack update ${pkgName} --to ${target} --allow-downgrade`,
        ],
      };
    }
    if (opts.allowDowngrade !== true) {
      failWith({
        what: `${target} is older than the installed ${installed} of '${pkgName}'.`,
        why: 'Going back a version is refused unless it is asked for in so many words: an older rule can accept what the installed one refuses. Nothing was updated.',
        next: `If that is what you mean, run: yg pack update ${pkgName} --to ${target} --allow-downgrade`,
      });
    }
  }

  // What the new version would do to the graph: a rule that is gone while
  // something still names it fails every check on the dangling name.
  const oldRules = await installedRuleDirs(graph, projectRoot, entry);
  const idPrefix = `${PACKAGES_DIR}/${entry.package}`;
  const removed = oldRules.filter((r) => !manifest.aspects.includes(r));
  const attached = attachmentsOf(graph, new Set(removed.map((r) => `${idPrefix}/${r}`)), idPrefix);
  if (attached.length > 0) {
    failWith({
      what: `${target} of '${pkgName}' no longer ships ${removed.map((r) => `'${r}'`).join(', ')}, and the graph still names it:\n${attached.map((a) => `  ${a.aspectId} — ${a.where}`).join('\n')}`,
      why: 'Replacing the copy would leave those references pointing at a rule that is gone, and every check would fail on the dangling names rather than on anything real. Nothing was updated.',
      next: 'Detach the rules listed above (or attach whatever replaces them in the new version), then run this again.',
    });
  }

  const summary = await describeUpdate(projectRoot, entry, manifest, packageRootAbs, newHashes.value, oldRules, removed);
  return {
    name: pkgName,
    entry,
    action: 'install',
    notes: [],
    install: { manifest, packageRootAbs, fetched, requested, summary },
  };
}

/** A rule's own file as a mapping, or null when it cannot be read. */
async function readRuleYaml(ruleDirAbs: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = parseYaml(await readTextFile(path.join(ruleDirAbs, 'yg-aspect.yaml'))) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch (err) {
    debugWrite(`[pack] reading ${ruleDirAbs}/yg-aspect.yaml: ${(err as Error).message}`);
    return null;
  }
}

/** The config keys an adaptation sets, or none. */
function adaptedKeys(adaptText: string | undefined): Set<string> {
  if (adaptText === undefined) return new Set();
  try {
    const parsed = parseYaml(adaptText) as { config?: unknown } | null;
    const config = parsed?.config;
    return config !== null && typeof config === 'object' && !Array.isArray(config) ? new Set(Object.keys(config)) : new Set();
  } catch (err) {
    debugWrite(`[pack] reading an adaptation's settings: ${(err as Error).message}`);
    return new Set();
  }
}

/**
 * What an update changes about the rules, said before anyone runs them.
 *
 * An update can promote a rule from draft to enforced, bundle in a rule nobody
 * attached, or change what a rule's code does — and every one of those takes
 * effect on the next `yg check --approve`. None of it may happen without the
 * person running the update being told.
 */
async function describeUpdate(
  projectRoot: string,
  entry: PackagesLockEntry,
  manifest: PackageManifest,
  newRootAbs: string,
  newHashes: Record<string, string>,
  oldRules: string[],
  removed: string[],
): Promise<string[]> {
  const lines: string[] = [];
  const oldRootAbs = installDirAbs(projectRoot, entry.package);
  const rel = installDirRelative(entry.package);
  const added = manifest.aspects.filter((r) => !oldRules.includes(r));
  if (added.length > 0) lines.push(`  new rules: ${added.join(', ')}`);
  if (removed.length > 0) {
    lines.push(chalk.yellow(`  rules no longer shipped, removed with their adaptations: ${removed.join(', ')}`));
  }

  const oldManifestResult = await parsePackageManifest(path.join(oldRootAbs, PACKAGE_FILENAME));
  const oldConfig = oldManifestResult.ok ? (oldManifestResult.value.config ?? {}) : {};
  const adapts = await readInstalledAdapts(projectRoot, entry.package, oldRules);

  for (const rule of manifest.aspects.filter((r) => oldRules.includes(r))) {
    const before = await readRuleYaml(path.join(oldRootAbs, rule));
    const after = await readRuleYaml(path.join(newRootAbs, rule));
    const statusOf = (y: Record<string, unknown> | null): string => (typeof y?.status === 'string' ? y.status : 'enforced');
    if (statusOf(before) !== statusOf(after)) lines.push(`  ${rule}: status ${statusOf(before)} → ${statusOf(after)}`);
    const impliesOf = (y: Record<string, unknown> | null): string =>
      Array.isArray(y?.implies) ? (y.implies as unknown[]).map((i) => (typeof i === 'string' ? i : JSON.stringify(i))).sort().join(', ') : '';
    if (impliesOf(before) !== impliesOf(after)) {
      lines.push(`  ${rule}: implies ${impliesOf(before) === '' ? '(nothing)' : impliesOf(before)} → ${impliesOf(after) === '' ? '(nothing)' : impliesOf(after)}`);
    }
    if (JSON.stringify(before?.scope ?? null) !== JSON.stringify(after?.scope ?? null)) lines.push(`  ${rule}: scope changed`);

    const prefix = `${rel}/${rule}/`;
    const changedCode = differingFiles(
      Object.fromEntries(Object.entries(entry.files).filter(([f]) => f.startsWith(prefix) && !f.startsWith(`${prefix}drills/`))),
      Object.fromEntries(Object.entries(newHashes).filter(([f]) => f.startsWith(prefix) && !f.startsWith(`${prefix}drills/`))),
    ).map((f) => f.slice(prefix.length));
    if (changedCode.length > 0) lines.push(`  ${rule}: changed ${changedCode.join(', ')}`);

    const oldKeys = oldConfig[rule] ?? {};
    const newKeys = manifest.config?.[rule] ?? {};
    const mine = adaptedKeys(adapts.get(rule));
    for (const key of Object.keys(newKeys).filter((k) => !(k in oldKeys)).sort()) {
      lines.push(`  ${rule}: new setting ${key} (default ${JSON.stringify(newKeys[key].default)})`);
    }
    for (const key of Object.keys(oldKeys).filter((k) => !(k in newKeys)).sort()) {
      lines.push(
        mine.has(key)
          ? chalk.yellow(`  ${rule}: setting ${key} is gone, and your ${ADAPT_FILENAME} still sets it — the graph refuses to load until you remove it there`)
          : `  ${rule}: setting ${key} is gone`,
      );
    }
    for (const key of Object.keys(newKeys).filter((k) => k in oldKeys).sort()) {
      if (oldKeys[key].default === newKeys[key].default) continue;
      lines.push(
        mine.has(key)
          ? `  ${rule}: the default of ${key} is now ${JSON.stringify(newKeys[key].default)} (was ${JSON.stringify(oldKeys[key].default)}); your adaptation keeps it at its own value`
          : `  ${rule}: the default of ${key} is now ${JSON.stringify(newKeys[key].default)} (was ${JSON.stringify(oldKeys[key].default)})`,
      );
    }
  }
  return lines;
}

// ============================================================
// list
// ============================================================
