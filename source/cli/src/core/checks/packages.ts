import path from 'node:path';

import type { Graph } from '../../model/graph.js';
import type { PackagesLock } from '../../model/packages.js';
import type { ValidationIssue } from '../../model/validation.js';
import { ADAPT_FILENAME, PACKAGES_LOCK_FILENAME } from '../../model/packages.js';
import { parsePackagesLock } from '../../io/package-manifest-parser.js';
import { hashAspectsRelativeFile, listAllPackageFiles, packagesLockPath } from '../../io/package-store.js';
import { issueMsg } from './shared.js';

/**
 * source/cli/src/core/checks/packages.ts — the rail that keeps a copied rule a
 * copy.
 *
 * Law installed from someone else's repository is copied in verbatim and recorded
 * file by file. This compares the record against what is actually on disk and
 * refuses three things: a copied file whose content moved, a copied file that is
 * gone, and a file sitting among the copies that no installed package accounts
 * for. The third is the one with teeth — dropping your own `check.mjs` beside
 * someone else's is how a rule nobody agreed to would wear a package's name.
 *
 * It is built into `yg check` rather than written as an aspect, and that is
 * deliberate: an aspect has a `check.mjs` a repository can sharpen and a marker a
 * repository can suppress. This has neither. The whole value of installing law
 * from elsewhere is that what you run is what they published, and a rail you can
 * turn off does not carry that.
 *
 * The consumer's own `yg-aspect.adapt.yaml` is never checked and never recorded.
 * It is the place a repository is MEANT to write, and objecting to it would leave
 * nowhere to adapt a rule at all.
 */

/** The one blocking code this rail emits. */
export const PACKAGE_FILE_MODIFIED = 'package-file-modified';

/** What has moved under one installed package since it was installed. */
export interface PackageDrift {
  /** Recorded files whose content differs now. Paths relative to `.yggdrasil/aspects/`. */
  modified: string[];
  /** Recorded files that are no longer there. */
  missing: string[];
}

export interface PackagesDrift {
  /** Per installed package name. Every package in the lock has an entry, even a clean one. */
  byPackage: Map<string, PackageDrift>;
  /** Files under the packages area that no installed package recorded. */
  unknown: string[];
}

/** True when nothing about an installed package's copy has moved. */
export function isCopyIntact(drift: PackageDrift | undefined): boolean {
  return drift === undefined || (drift.modified.length === 0 && drift.missing.length === 0);
}

/** Repository-relative POSIX path of a file addressed relative to `.yggdrasil/aspects/`. */
export function repoRelativePackagePath(aspectsRelPath: string): string {
  return `.yggdrasil/aspects/${aspectsRelPath}`;
}

/**
 * Compare every recorded file against the copy on disk.
 *
 * Shared by the rail below and by `yg pack update` / `yg pack list`, so what the
 * gate calls tampering and what an update refuses to overwrite can never be two
 * different questions.
 */
export async function collectPackagesDrift(
  projectRoot: string,
  lock: PackagesLock,
): Promise<PackagesDrift> {
  const expected = new Map<string, { hash: string; packageName: string }>();
  const byPackage = new Map<string, PackageDrift>();
  for (const [packageName, entry] of Object.entries(lock.packages)) {
    byPackage.set(packageName, { modified: [], missing: [] });
    for (const [filePath, hash] of Object.entries(entry.files)) {
      expected.set(filePath, { hash, packageName });
    }
  }

  const actual = await listAllPackageFiles(projectRoot);
  const actualSet = new Set(actual);
  const unknown: string[] = [];

  for (const filePath of actual) {
    // The adapt file is the consumer's own writing. It is never in the lock and
    // is never judged here — that is the whole point of it existing.
    if (path.posix.basename(filePath) === ADAPT_FILENAME) continue;
    const record = expected.get(filePath);
    if (record === undefined) {
      unknown.push(filePath);
      continue;
    }
    const current = await hashAspectsRelativeFile(projectRoot, filePath);
    if (current !== record.hash) byPackage.get(record.packageName)?.modified.push(filePath);
  }

  for (const [filePath, record] of expected) {
    if (!actualSet.has(filePath)) byPackage.get(record.packageName)?.missing.push(filePath);
  }

  return { byPackage, unknown };
}

function issue(messageData: { what: string; why: string; next: string }): ValidationIssue {
  return {
    severity: 'error',
    code: PACKAGE_FILE_MODIFIED,
    rule: PACKAGE_FILE_MODIFIED,
    ...issueMsg(messageData),
    messageData,
  };
}

/**
 * Verify every installed package's copy against what the lock recorded.
 *
 * A repository with no packages does no work and produces nothing: the lock is
 * absent (which reads as empty) and the packages directory is absent (which reads
 * as no files), so both sides are empty and the comparison is trivially clean.
 */
export async function checkPackageFilesModified(graph: Graph): Promise<ValidationIssue[]> {
  const projectRoot = path.dirname(graph.rootPath);

  const lockResult = await parsePackagesLock(packagesLockPath(projectRoot));
  if (!lockResult.ok) {
    // The record itself cannot be read. Reporting this as "nothing installed"
    // would silently stop checking every copied rule in the repository, so it
    // blocks under this rail's own code rather than passing quietly.
    return lockResult.errors.map((e) =>
      issue({
        what: e.messageData.what,
        why: `${e.messageData.why} Until it can be read, no installed rule can be checked against what its package published.`,
        next: e.messageData.next,
      }),
    );
  }

  const drift = await collectPackagesDrift(projectRoot, lockResult.value);
  const issues: ValidationIssue[] = [];

  for (const filePath of drift.unknown) {
    issues.push(
      issue({
        what: `${repoRelativePackagePath(filePath)} sits among the installed packages, but no installed package put it there.`,
        why: `Everything under .yggdrasil/aspects/packages/ is a copy of law published elsewhere, recorded file by file in .yggdrasil/${PACKAGES_LOCK_FILENAME}. A file that is not in that record is a rule nobody chose, wearing a package's name.`,
        next: `Delete ${repoRelativePackagePath(filePath)}. To add a rule of your own, put it in .yggdrasil/aspects/ outside packages/; to change one you installed, edit its ${ADAPT_FILENAME}.`,
      }),
    );
  }

  for (const [packageName, packageDrift] of drift.byPackage) {
    for (const filePath of packageDrift.modified) {
      issues.push(
        issue({
          what: `${repoRelativePackagePath(filePath)} has been edited since it was installed from the package '${packageName}'.`,
          why: "A rule installed from someone else's repository is a copy: an update replaces it wholesale, so an edit here is silently discarded the next time the package moves — and until then, what runs is no longer what the package published.",
          next: `Restore ${repoRelativePackagePath(filePath)} and put your change in the ${ADAPT_FILENAME} beside it instead. To take the change wholesale, run: yg pack update ${packageName}`,
        }),
      );
    }
    for (const filePath of packageDrift.missing) {
      issues.push(
        issue({
          what: `${repoRelativePackagePath(filePath)} is missing — the package '${packageName}' installed it and it is no longer there.`,
          why: 'The package is recorded as installed, so this file is part of the law this repository is running. A rule with a piece missing does not fail loudly; it stops applying.',
          next: `Restore the file, or reinstall the package: yg pack update ${packageName}. To stop using it entirely, run: yg pack remove ${packageName}`,
        }),
      );
    }
  }

  // Sorted by the file each issue names, so two runs over the same repository
  // report in the same order regardless of how the directory walk interleaved.
  return issues.sort((a, b) =>
    a.messageData.what < b.messageData.what ? -1 : a.messageData.what > b.messageData.what ? 1 : 0,
  );
}
