/**
 * source/cli/src/core/advise-package-nominations.ts — the attention item that
 * says a rule you installed has moved on.
 *
 * Kept out of the main nominations engine for the same reason the imported and
 * architecture-cut sources are: that file is the one this repository's own
 * reviewer prompt runs closest to its ceiling on, and a source with a single
 * entry point is the cheapest thing to move. It also happens to be the honest
 * split — like `imported`, everything here came from OUTSIDE this graph, and
 * having those sources in files of their own means a reader can see at a glance
 * which code turns this repository's own evidence into items and which carries
 * somebody else's.
 *
 * INJECTION HYGIENE, and it is not optional here: every value below came out of
 * another repository — the package's name, the versions it publishes, the source
 * it was fetched from. A version tag is a string the package author chose, and
 * the feed is read by an agent every session, so this is precisely where a
 * crafted tag would try to read as an instruction. Each value goes through
 * `quoteData` and is rendered as quoted data with its provenance; none is ever
 * spliced into a narrator-voice sentence.
 */

import { gt as semverGt, valid as validSemver } from 'semver';

import type { Nomination } from './advise-nominations.js';
import { CLASS_RANK, asApprovalNext, hashEvidence, quoteData } from './advise-nominations.js';

/**
 * What a reachable source says about one installed package. Assembled at the CLI
 * boundary — this engine never runs git and never reads a file.
 */
export interface PackageUpdateSignal {
  /** The installed package's name, as this repository knows it. UNTRUSTED text. */
  name: string;
  /** The version currently installed. UNTRUSTED text (it came from the package). */
  installedVersion: string;
  /** Versions the source publishes that this repository does not have. Non-empty, UNTRUSTED. */
  newerVersions: string[];
  /** Where it was installed from, as recorded. UNTRUSTED text. */
  source: string;
}

/**
 * Which of the versions a source publishes are actually NEWER than the installed
 * one, in ascending order.
 *
 * Strictly newer, not merely different: after an update the record still lists
 * every version the source published, older ones included, and reporting one of
 * those would tell someone running the latest release that there is something to
 * take. A tag that is not semver at all is skipped — it came out of someone
 * else's repository, and nothing here can order it.
 */
export function newerThanInstalled(published: readonly string[], installed: string): string[] {
  if (validSemver(installed) === null) return [];
  return published
    .filter((v) => validSemver(v) !== null && semverGt(v, installed))
    .sort((a, b) => (semverGt(a, b) ? 1 : semverGt(b, a) ? -1 : 0));
}

/**
 * One nomination per installed package whose source publishes something newer.
 *
 * A package whose source could not be reached is ABSENT from `updates` — never
 * present with an empty list. That distinction is the CLI boundary's to keep, and
 * it is what stops an offline run from producing an item claiming there is
 * nothing newer, which would be a finding the run never made.
 */
export function packageUpdateNominations(
  updates: readonly PackageUpdateSignal[],
  todayIso: string,
): Nomination[] {
  const nominations: Nomination[] = [];
  // EVERY value below came out of somebody else's repository — the package's
  // name, the versions it publishes, the source it was fetched from — so every
  // one of them is rendered as quoted data and none is ever spliced into a
  // narrator-voice sentence. A tag is a string the package author chose, and the
  // feed is read by an agent each session: this is exactly where a crafted tag
  // would try to read as an instruction.
  for (const update of updates) {
    const nameQ = quoteData(update.name);
    const installedQ = quoteData(update.installedVersion);
    const availableQ = update.newerVersions.map((v) => `"${quoteData(v)}"`).join(', ');
    nominations.push({
      id: `package-update:${update.name}`,
      classRank: CLASS_RANK.packageUpdate,
      what: `The package "${nameQ}" is installed at version "${installedQ}", and its source publishes ${availableQ}.`,
      why:
        `read from "${quoteData(update.source)}", which this repository recorded as where "${nameQ}" came from. ` +
        `The version numbers and the package name are that source's own words, not this graph's finding. ` +
        `Nothing is wrong with the version you have — it is a choice you have not made yet.`,
      next: asApprovalNext(
        `Read what changed in the newer version at its source, then take it with yg pack update ${update.name} ` +
          `(your adaptations survive; the copied rule files are replaced).`,
      ),
      evidenceHash: hashEvidence({
        source: 'package-update',
        name: update.name,
        installed: update.installedVersion,
        available: [...update.newerVersions].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(','),
      }),
      evidenceTs: todayIso,
    });
  }
  return nominations;
}
