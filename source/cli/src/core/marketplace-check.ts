import path from 'node:path';

import type { IssueMessage, IssueSeverity } from '../model/validation.js';
import type { AspectDef, FileWhenPredicate } from '../model/graph.js';
import type { PackageManifest, MarketplaceEntry } from '../model/packages.js';
import { MARKETPLACE_FILENAME, PACKAGE_FILENAME, PACKAGES_DIR } from '../model/packages.js';
import { parseMarketplaceManifest, parsePackageManifest } from '../io/package-manifest-parser.js';
import { parseAspect } from '../io/aspect-parser.js';
import { listDirEntries, readTextFile, statKind } from '../io/graph-fs.js';
import { collectConfigReads } from '../structure/config-reads.js';
import { debugWrite } from '../utils/debug-log.js';
import { toPosixPath } from '../utils/posix.js';

/**
 * source/cli/src/core/marketplace-check.ts — everything a marketplace should be
 * asked before it publishes.
 *
 * This runs in the PUBLISHING repository, which is an ordinary git repository
 * with a manifest at its root and no `.yggdrasil/` of its own. That is the one
 * constraint everything else follows from: there is no graph here to load, no
 * lock to consult, and no reviewer to call. Every judgement below is made from
 * the manifests, the rule directories and the text of the rules themselves.
 *
 * Five questions, and no more (a longer list was tried and was a monster):
 *
 *   (a) Do the two manifests agree with the directories that are actually there?
 *   (b) Does every rule load, under the same loader a consumer will load it with?
 *   (c) Does every `implies` stay inside its own package?
 *   (d) Does every setting a rule reads exist, and does every setting declared
 *       get read?
 *   (e) Will the package still mean the same thing in somebody else's repository?
 *
 * Each check owns a fixed code, and the codes live HERE rather than in
 * `core/check-codes.ts`. That file says what it is for in its own first line: the
 * categories `yg check`'s engine tallies and its renderer groups. This command
 * runs in a different repository, on a different document, outside that pipeline
 * entirely — a code of ours in those sets would either join a category it does
 * not belong to or sit in a set nothing reads.
 */

/** One thing `marketplace check` found. */
export interface MarketplaceIssue {
  code: string;
  severity: IssueSeverity;
  /** Repository-relative POSIX path of what the finding is about, when there is one. */
  subject?: string;
  messageData: IssueMessage;
}

export interface MarketplaceCheckResult {
  errors: MarketplaceIssue[];
  warnings: MarketplaceIssue[];
}

/**
 * Every code this check can emit, by severity. Exported so a test can assert the
 * set is disjoint and complete rather than spot-checking sentences, and so the
 * command layer can print the catalogue without re-typing it.
 */
export const MARKETPLACE_ERROR_CODES = [
  'marketplace-manifest-missing',
  'marketplace-manifest-invalid',
  'marketplace-entry-missing',
  'marketplace-dir-unlisted',
  'package-manifest-invalid',
  'package-name-mismatch',
  'package-aspect-invalid',
  'package-implies-escapes',
  'package-config-undeclared',
  'package-scope-literal-root',
  'package-review-by-present',
  'package-references-repo-path',
  'package-drills-missing',
  'package-file-unreadable',
] as const;

export const MARKETPLACE_WARNING_CODES = [
  'package-config-unused',
  'package-config-dynamic',
  'package-reviewer-tier',
  'package-drills-unrecognized',
] as const;



function issue(
  code: string,
  severity: IssueSeverity,
  messageData: IssueMessage,
  subject?: string,
): MarketplaceIssue {
  return { code, severity, ...(subject !== undefined && { subject }), messageData };
}

/** Repository-relative POSIX path of `abs` inside the marketplace at `root`. */
function rel(root: string, abs: string): string {
  return toPosixPath(path.relative(root, abs));
}

/** Directory names directly under `dir`, sorted. Missing directory ⇒ empty. */
async function subdirectories(dir: string): Promise<string[]> {
  const entries = await listDirEntries(dir);
  if (entries === null) return [];
  return entries
    .filter((e) => e.kind === 'dir')
    .map((e) => e.name)
    .sort();
}


/**
 * Every `path:` glob in a file predicate, in declaration order.
 *
 * `scope.files` is a whole boolean tree, so a literal root can hide under a `not:`
 * or one branch of an `any_of:` just as easily as it can sit at the top.
 */
function pathAtoms(predicate: FileWhenPredicate): string[] {
  const out: string[] = [];
  const visit = (node: FileWhenPredicate): void => {
    if ('all_of' in node) node.all_of.forEach(visit);
    else if ('any_of' in node) node.any_of.forEach(visit);
    else if ('not' in node) visit(node.not);
    else if (typeof node.path === 'string') out.push(node.path);
  };
  visit(predicate);
  return out;
}

/**
 * True when a glob is anchored to a directory that has to exist by that name.
 *
 * A glob whose first segment carries no wildcard only ever matches a repository
 * laid out with a directory of exactly that name at its root; the same glob
 * prefixed with a match-any-depth segment matches wherever the directory sits. A
 * package cannot know the layout of the repository it lands in, so the first is a
 * rule that silently applies to nothing there.
 */
function hasLiteralRoot(glob: string): boolean {
  const first = glob.split('/')[0];
  return first !== '' && !first.includes('*');
}

/** Read a text file, or return null when it cannot be read. */
async function readOrNull(filePath: string): Promise<string | null> {
  try {
    return await readTextFile(filePath);
  } catch (err) {
    debugWrite(`[marketplace-check] could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Ask a marketplace repository at `root` whether it is fit to publish.
 *
 * Pure in the sense that matters here: it reads the tree and returns findings,
 * never writing, never exiting, and never loading a graph — so a test can call it
 * directly on a fixture and a command can call it on the user's repository, and
 * both are looking at the same judgement.
 */
export async function checkMarketplace(root: string): Promise<MarketplaceCheckResult> {
  const errors: MarketplaceIssue[] = [];
  const warnings: MarketplaceIssue[] = [];
  const record = (i: MarketplaceIssue): void => {
    (i.severity === 'error' ? errors : warnings).push(i);
  };

  // ── (a) The manifests, and the directories they claim ──────────────────────
  const manifestPath = path.join(root, MARKETPLACE_FILENAME);
  const rootForOutput = toPosixPath(root);
  const manifest = await parseMarketplaceManifest(manifestPath);
  if (!manifest.ok) {
    const first = manifest.errors[0];
    // The parser's absent-file message is written for `yg pack add`, which is
    // pointing at somebody else's repository. Here the reader IS in the
    // repository, so the next step is to create the file rather than to aim
    // somewhere better.
    if (first.code === 'marketplace-manifest-missing') {
      record(
        issue('marketplace-manifest-missing', 'error', {
          what: `There is no ${MARKETPLACE_FILENAME} at ${rootForOutput}.`,
          why: 'A marketplace is a git repository that publishes law from a manifest at its root. Without that file there is nothing here to check.',
          next: `Run 'yg marketplace init' in this repository to create ${MARKETPLACE_FILENAME}, or change to the directory that has one.`,
        }),
      );
    } else {
      record(issue('marketplace-manifest-invalid', 'error', first.messageData, MARKETPLACE_FILENAME));
    }
    return { errors, warnings };
  }

  const entries = manifest.value.packages;
  const claimed = new Set(entries.map((e) => e.path));

  for (const dirName of await subdirectories(path.join(root, PACKAGES_DIR))) {
    const dirPath = `${PACKAGES_DIR}/${dirName}`;
    if (claimed.has(dirPath)) continue;
    record(
      issue(
        'marketplace-dir-unlisted',
        'error',
        {
          what: `${dirPath} is a package directory that ${MARKETPLACE_FILENAME} does not list.`,
          why: 'The manifest is the whole of what this repository publishes. A directory it does not name is law nobody can install and nobody is reviewing — and the next reader will not be able to tell whether it was forgotten or abandoned.',
          next: `Add an entry { name, path: ${dirPath}, version } to packages: in ${MARKETPLACE_FILENAME}, or delete the directory.`,
        },
        dirPath,
      ),
    );
  }

  for (const entry of entries) {
    await checkOnePackage(root, entry, record);
  }

  return { errors, warnings };
}

/** Everything asked of one published package. */
async function checkOnePackage(
  root: string,
  entry: MarketplaceEntry,
  record: (i: MarketplaceIssue) => void,
): Promise<void> {
  const pkgDir = path.join(root, entry.path);
  const pkgManifestPath = path.join(pkgDir, PACKAGE_FILENAME);

  if ((await statKind(pkgDir)) !== 'dir' || (await statKind(pkgManifestPath)) !== 'file') {
    record(
      issue(
        'marketplace-entry-missing',
        'error',
        {
          what: `${MARKETPLACE_FILENAME} publishes '${entry.name}' from ${entry.path}, where there is no ${PACKAGE_FILENAME}.`,
          why: 'A published entry is a promise that the directory is there and carries its own manifest. Installing this one would fail in somebody else\'s repository, at the point where nothing local explains it.',
          next: `Create ${entry.path}/${PACKAGE_FILENAME}, or remove the '${entry.name}' entry from packages: in ${MARKETPLACE_FILENAME}.`,
        },
        entry.path,
      ),
    );
    return;
  }

  const presentDirs = (await subdirectories(pkgDir)).filter((d) => d !== 'node_modules');
  const parsed = await parsePackageManifest(pkgManifestPath, presentDirs);
  if (!parsed.ok) {
    record(
      issue(
        'package-manifest-invalid',
        'error',
        parsed.errors[0].messageData,
        rel(root, pkgManifestPath),
      ),
    );
    return;
  }
  const pkg = parsed.value;

  const dirName = path.basename(entry.path);
  if (pkg.name !== entry.name || pkg.name !== dirName) {
    record(
      issue(
        'package-name-mismatch',
        'error',
        {
          what: `The package in ${entry.path} calls itself '${pkg.name}'; the marketplace publishes it as '${entry.name}' and it sits in a directory called '${dirName}'.`,
          why: 'Every command a consumer runs afterwards addresses a package by name — updating it, removing it, reading its record. Two documents disagreeing about that name means the copy is filed under one and the record under the other.',
          next: `Make all three agree: set name: in ${entry.path}/${PACKAGE_FILENAME}, the entry's name: in ${MARKETPLACE_FILENAME}, and the directory name to the same word.`,
        },
        rel(root, pkgManifestPath),
      ),
    );
  }

  for (const aspectDir of pkg.aspects) {
    await checkOneAspect(root, entry, pkg, aspectDir, record);
  }
}

/** Everything asked of one rule inside a published package. */
async function checkOneAspect(
  root: string,
  entry: MarketplaceEntry,
  pkg: PackageManifest,
  aspectDir: string,
  record: (i: MarketplaceIssue) => void,
): Promise<void> {
  const dir = path.join(root, entry.path, aspectDir);
  const relDir = `${entry.path}/${aspectDir}`;
  const yamlPath = path.join(dir, 'yg-aspect.yaml');

  if ((await statKind(yamlPath)) !== 'file') {
    record(
      issue(
        'package-aspect-invalid',
        'error',
        {
          what: `The rule '${aspectDir}' in package '${pkg.name}' has no yg-aspect.yaml.`,
          why: 'A rule is a directory carrying yg-aspect.yaml; without it there is nothing declaring what the rule is or who reviews it.',
          next: `Add ${relDir}/yg-aspect.yaml, or remove '${aspectDir}' from aspects: in ${entry.path}/${PACKAGE_FILENAME}.`,
        },
        relDir,
      ),
    );
    return;
  }

  const hasCheck = (await statKind(path.join(dir, 'check.mjs'))) === 'file';
  const hasContent = (await statKind(path.join(dir, 'content.md'))) === 'file';
  if (hasCheck && hasContent) {
    record(
      issue(
        'package-aspect-invalid',
        'error',
        {
          what: `The rule '${aspectDir}' in package '${pkg.name}' ships both check.mjs and content.md.`,
          why: 'A rule is judged one way: a local script, or a reviewer reading prose. Shipping both leaves which one applies to whichever check the consumer happens to run.',
          next: `Delete one of ${relDir}/check.mjs or ${relDir}/content.md, or split the rule in two and list both in aspects:.`,
        },
        relDir,
      ),
    );
    return;
  }

  // (b) The rule is loaded with the SAME loader a consumer's graph will load it
  // with, in package mode — so what refuses here is what would refuse there,
  // rather than a second opinion written for this command.
  let loaded;
  try {
    loaded = await parseAspect(dir, yamlPath, `${pkg.name}/${aspectDir}`, {
      projectRoot: root,
      package: {
        packageName: pkg.name,
        idPrefix: `${PACKAGES_DIR}/${pkg.name}`,
        aspectDirs: pkg.aspects,
        relativeId: aspectDir,
        configSchema: pkg.config?.[aspectDir] ?? {},
      },
    });
  } catch (err) {
    // The loader reads the rule's own files and throws when one of them cannot
    // be read at all. Here that is a fact about the package, not a bug in the
    // tool, and it belongs in the report beside every other finding rather than
    // ending the run as an unclassified crash.
    record(
      issue(
        'package-file-unreadable',
        'error',
        {
          what: `The rule '${aspectDir}' in package '${pkg.name}' could not be read: ${err instanceof Error ? err.message : String(err)}`,
          why: 'Every file in a package is copied into whoever installs it. One that cannot be read here cannot be copied, and cannot be checked for anything.',
          next: `Check the permissions on the files under ${relDir}.`,
        },
        relDir,
      ),
    );
    return;
  }
  if (!loaded.ok) {
    const first = loaded.errors[0];
    // (c) The loader already refuses an `implies` that is not a bare name of a
    // rule in this package, in both of its forms. Re-deciding it here would be a
    // second definition of the same boundary.
    const isImplies = first.code.startsWith('package-implies-');
    record(
      issue(
        isImplies ? 'package-implies-escapes' : 'package-aspect-invalid',
        'error',
        first.messageData,
        relDir,
      ),
    );
    return;
  }
  const aspect = loaded.aspect;

  if (!hasCheck && !hasContent && (aspect.implies?.length ?? 0) === 0) {
    record(
      issue(
        'package-aspect-invalid',
        'error',
        {
          what: `The rule '${aspectDir}' in package '${pkg.name}' ships neither check.mjs nor content.md and implies nothing.`,
          why: 'A rule with no script, no prose and nothing to bundle does nothing at all, and installs as law that can never refuse anything.',
          next: `Add a check.mjs, a content.md, or an implies: naming the rules of this package that ${aspectDir} stands for.`,
        },
        relDir,
      ),
    );
    return;
  }

  await checkPortability(relDir, pkg, aspectDir, aspect, record);
  await checkConfigAgreement(root, relDir, pkg, aspectDir, hasCheck, record);
  if (aspect.reviewer.type === 'deterministic') {
    await checkDrills(dir, relDir, pkg, aspectDir, record);
  }
}

/** (e) Will this rule still mean the same thing in a repository it has never seen? */
async function checkPortability(
  relDir: string,
  pkg: PackageManifest,
  aspectDir: string,
  aspect: AspectDef,
  record: (i: MarketplaceIssue) => void,
): Promise<void> {
  if (aspect.reviewBy !== undefined) {
    record(
      issue(
        'package-review-by-present',
        'error',
        {
          what: `The rule '${aspectDir}' in package '${pkg.name}' declares review_by: ${aspect.reviewBy}.`,
          why: 'A review-by date is a repository asking itself to re-examine whether a rule still earns its place there. Published, it becomes the author\'s reminder appearing in everybody else\'s repository, on a date none of them chose.',
          next: `Remove review_by: from ${relDir}/yg-aspect.yaml. A consumer who wants one sets it in the yg-aspect.adapt.yaml beside their copy.`,
        },
        relDir,
      ),
    );
  }

  for (const reference of aspect.references ?? []) {
    record(
      issue(
        'package-references-repo-path',
        'error',
        {
          what: `The rule '${aspectDir}' in package '${pkg.name}' names the reference file '${reference.path}'.`,
          why: 'A reference is a repository-relative path read at review time. The package does not know the layout of the repository it lands in, so the path resolves to whatever happens to sit there — or to nothing.',
          next: `Remove references: from ${relDir}/yg-aspect.yaml and put what the reviewer needs into content.md, or let a consumer add the reference in the yg-aspect.adapt.yaml beside their copy.`,
        },
        relDir,
      ),
    );
  }

  if (aspect.reviewer.tier !== undefined) {
    record(
      issue(
        'package-reviewer-tier',
        'warning',
        {
          what: `The rule '${aspectDir}' in package '${pkg.name}' asks for reviewer tier '${aspect.reviewer.tier}'.`,
          why: 'Tiers are named per repository. A tier this package names may not exist where it is installed, and where it does exist it may mean a different model at a different cost than the author had in mind.',
          next: `Consider removing tier: from ${relDir}/yg-aspect.yaml and letting each consumer choose in their adaptation.`,
        },
        relDir,
      ),
    );
  }

  for (const glob of aspect.scope?.files === undefined ? [] : pathAtoms(aspect.scope.files)) {
    if (!hasLiteralRoot(glob)) continue;
    record(
      issue(
        'package-scope-literal-root',
        'error',
        {
          what: `The rule '${aspectDir}' in package '${pkg.name}' scopes itself to '${glob}', which is anchored to a directory named '${glob.split('/')[0]}'.`,
          why: 'The package cannot know where a consumer keeps their code. A glob anchored to one directory name matches everything in a repository laid out that way and silently nothing in every other one — a rule that appears installed and never fires.',
          next: `In ${relDir}/yg-aspect.yaml, make the glob relative to any depth, e.g. '**/${glob}'.`,
        },
        relDir,
      ),
    );
  }
}

/** (d) Does every setting a rule reads exist, and does every setting declared get read? */
async function checkConfigAgreement(
  root: string,
  relDir: string,
  pkg: PackageManifest,
  aspectDir: string,
  hasCheck: boolean,
  record: (i: MarketplaceIssue) => void,
): Promise<void> {
  const declared = new Set(Object.keys(pkg.config?.[aspectDir] ?? {}));
  const readKeys = new Set<string>();
  let dynamic = false;

  const scripts = [hasCheck ? 'check.mjs' : null, 'companion.mjs'].filter(
    (f): f is string => f !== null,
  );
  for (const filename of scripts) {
    const abs = path.join(root, relDir, filename);
    if ((await statKind(abs)) !== 'file') continue;
    const source = await readOrNull(abs);
    if (source === null) {
      record(
        issue(
          'package-file-unreadable',
          'error',
          {
            what: `${relDir}/${filename} could not be read.`,
            why: 'A file that cannot be read here cannot be copied into a consumer, and its rule cannot be checked at all — so publishing would ship a rule nobody has looked at.',
            next: `Check the permissions on ${relDir}/${filename}.`,
          },
          `${relDir}/${filename}`,
        ),
      );
      continue;
    }
    const reads = await collectConfigReads(abs, source);
    for (const key of reads.keys) readKeys.add(key);
    if (reads.dynamic) dynamic = true;
  }

  for (const key of [...readKeys].sort()) {
    if (declared.has(key)) continue;
    record(
      issue(
        'package-config-undeclared',
        'error',
        {
          what: `The rule '${aspectDir}' in package '${pkg.name}' reads the setting '${key}', which ${PACKAGE_FILENAME} does not declare.`,
          why: 'An undeclared setting reads as undefined in every repository that installs this package, and there is nothing for a consumer to set — the rule silently runs on nothing where it was written to run on a value.',
          next: `Add config.${aspectDir}.${key} with a type and a default to ${pkg.name}'s ${PACKAGE_FILENAME}, or stop reading it in ${relDir}/check.mjs.`,
        },
        relDir,
      ),
    );
  }

  if (dynamic) {
    // A rule that reaches its settings through a name computed at run time is not
    // wrong — it is unreadable from here. Saying so, and then declining to draw
    // the "declared but never read" conclusion, is the honest half of the check.
    record(
      issue(
        'package-config-dynamic',
        'warning',
        {
          what: `The rule '${aspectDir}' in package '${pkg.name}' reaches its settings through a name that is not written out in the source.`,
          why: 'Which settings it reads cannot be worked out without running it, so this check can confirm the ones it can see and can say nothing about the rest.',
          next: `Read each setting as ctx.config.<name> in ${relDir} if you want this check to cover them.`,
        },
        relDir,
      ),
    );
    return;
  }

  for (const key of [...declared].sort()) {
    if (readKeys.has(key)) continue;
    record(
      issue(
        'package-config-unused',
        'warning',
        {
          what: `Package '${pkg.name}' declares the setting '${aspectDir}.${key}', which the rule never reads.`,
          why: 'A setting nothing consults is one a consumer can find, set, and get no change from — and because a setting only enters a verdict when it is read, changing it re-opens nothing either.',
          next: `Read it in ${relDir}/check.mjs, or remove config.${aspectDir}.${key} from ${PACKAGE_FILENAME}.`,
        },
        relDir,
      ),
    );
  }
}

/**
 * (e, continued) A deterministic rule ships the cases that prove it.
 *
 * Presence only, and deliberately so: RUNNING a case needs the graph context a
 * rule is handed, and a marketplace repository has no graph — that is the whole
 * reason this command does not load one. So this asks whether the corpus is there
 * and shaped the way the runner recognises, and leaves the running to `yg drill`
 * in a repository that has a graph to run it against.
 */
async function checkDrills(
  dir: string,
  relDir: string,
  pkg: PackageManifest,
  aspectDir: string,
  record: (i: MarketplaceIssue) => void,
): Promise<void> {
  const drillsDir = path.join(dir, 'drills');
  const cases = await subdirectories(drillsDir);
  const violates = cases.filter((c) => c.startsWith('violates-'));
  const satisfies = cases.filter((c) => c.startsWith('satisfies-'));

  if (violates.length === 0 || satisfies.length === 0) {
    record(
      issue(
        'package-drills-missing',
        'error',
        {
          what: `The rule '${aspectDir}' in package '${pkg.name}' has ${cases.length === 0 ? 'no drills/ directory' : `drills/ with ${violates.length} case that must be refused and ${satisfies.length} that must pass`}.`,
          why: 'A published rule runs somebody else\'s code against somebody else\'s repository. The pair of cases is the only thing that shows what it refuses and what it lets through, and it is the only thing a consumer can run to see the rule work before they trust it.',
          next: `Add ${relDir}/drills/violates-<name>/ and ${relDir}/drills/satisfies-<name>/, each holding one source file, then run 'yg drill --aspect <id>' in a repository that has the rule installed.`,
        },
        relDir,
      ),
    );
  }

  for (const name of cases) {
    if (name.startsWith('violates-') || name.startsWith('satisfies-')) continue;
    record(
      issue(
        'package-drills-unrecognized',
        'warning',
        {
          what: `${relDir}/drills/${name}/ is named neither 'violates-…' nor 'satisfies-…'.`,
          why: 'The runner reads the first path segment to learn what a case is supposed to prove, and skips a directory it cannot read that from — so everything in there looks like a case and runs as none.',
          next: `Rename it to violates-${name} or satisfies-${name}, or move it out of drills/ if it holds shared material rather than cases.`,
        },
        `${relDir}/drills/${name}`,
      ),
    );
  }
}

