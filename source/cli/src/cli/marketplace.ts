import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

import { abortOnUnexpectedError } from './preamble.js';
import { exitAfterFlush } from './exit-after-flush.js';
import { debugWrite } from '../utils/debug-log.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import type { IssueMessage } from '../model/validation.js';
import { MARKETPLACE_FILENAME, PACKAGES_DIR } from '../model/packages.js';
import { atomicWriteFile } from '../io/atomic-write.js';
import { checkMarketplace } from '../core/marketplace-check.js';
import { toPosixPath } from '../utils/posix.js';
import type { MarketplaceIssue } from '../core/marketplace-check.js';

/**
 * `yg marketplace` — start a repository that publishes law, and ask it whether it
 * is fit to publish.
 *
 * A marketplace is an ordinary git repository with a manifest at its root. It is
 * NOT a Yggdrasil project: it has no `.yggdrasil/`, no graph, no lock and nothing
 * to enforce, because the law it holds is meant to run in somebody else's
 * repository rather than in this one. That is why neither subcommand here goes
 * anywhere near `loadGraphOrAbort` — a marketplace with no graph is the normal
 * case, and a refusal asking the author to run `yg init` would be sending them to
 * build the wrong thing.
 */

/** Emit a blocking what/why/next error to stderr and exit(1) — nothing is written. */
function failWith(msg: IssueMessage): never {
  process.stderr.write(chalk.red(`Error: ${buildIssueMessage(msg)}`) + '\n');
  process.exit(1);
}

/**
 * Walk up from `startDir` looking for a directory that holds `marker`.
 *
 * Same discovery git itself does, and for the same reason: someone standing in a
 * package directory means the repository they are standing in, not the directory
 * they happen to have `cd`-ed to. Returns null at the filesystem root.
 */
export function findUpwards(startDir: string, marker: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The manifest a fresh marketplace starts from: a schema line and nothing published. */
export function initialMarketplaceManifest(): string {
  return [
    '# This repository publishes Yggdrasil rules.',
    '#',
    '# A marketplace is an ordinary git repository with this file at its root.',
    '# Nothing registers anywhere: a consumer installs from the URL they type, so',
    '# the same package published from two forks is two different packages and',
    '# neither can claim the other\'s name.',
    '#',
    '# Add a package with: yg pack new <name>',
    'schema: yg-marketplace/1',
    'packages: []',
    '',
  ].join('\n');
}

/** The filename of the workflow `marketplace init` writes. */
export const CI_WORKFLOW_FILENAME = 'yg-marketplace.yml';

/**
 * The CI workflow that runs the pre-publish check.
 *
 * DELIBERATE CHOICE, of the two the design allowed: a NEW dedicated file rather
 * than a step appended into the first existing workflow. Appending means editing
 * a YAML document somebody else wrote and owns — one whose job names, matrix and
 * indentation this command would have to infer — and getting it subtly wrong
 * breaks their build rather than ours. A file of our own is deterministic, is
 * obvious in a diff, and is deleted by deleting one file.
 */
export function ciWorkflowText(): string {
  return [
    '# Checks this marketplace before anyone can install from it.',
    '# Written by `yg marketplace init`. Delete this file to opt out.',
    'name: Marketplace',
    '',
    'on:',
    '  push:',
    '  pull_request:',
    '',
    'jobs:',
    '  check:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 22',
    '      - run: npx --yes @chrisdudek/yg marketplace check',
    '',
  ].join('\n');
}

/**
 * The two handlers are named for the command they serve rather than for the
 * subcommand alone. `runCheck` in particular is taken: it is the check engine's
 * entry point, and a second bare function of that name here would be read as a
 * call site of it by anything scanning the repository for one — including the
 * rail that keeps every real call site of it guarded.
 */
async function runMarketplaceInit(): Promise<void> {
  const cwd = process.cwd();
  const gitRoot = findUpwards(cwd, '.git');
  if (gitRoot === null) {
    failWith({
      what: `${toPosixPath(cwd)} is not inside a git repository.`,
      why: 'A marketplace IS a git repository: consumers install from its URL and pin a version by its tags, so there is nowhere for a package to be published from until one exists.',
      next: 'Run `git init` here (or change to a repository you have already created), then run `yg marketplace init` again.',
    });
  }

  const manifestPath = path.join(gitRoot, MARKETPLACE_FILENAME);
  if (existsSync(manifestPath)) {
    failWith({
      what: `${toPosixPath(gitRoot)} already has a ${MARKETPLACE_FILENAME}.`,
      why: 'That file is the whole record of what this repository publishes. Rewriting it would drop every entry in it, and nothing else here would notice.',
      next: `Add a package with \`yg pack new <name>\`, or check what is there with \`yg marketplace check\`. To start over, delete ${MARKETPLACE_FILENAME} first.`,
    });
  }

  await atomicWriteFile(manifestPath, initialMarketplaceManifest());
  mkdirSync(path.join(gitRoot, PACKAGES_DIR), { recursive: true });

  const workflowsDir = path.join(gitRoot, '.github', 'workflows');
  let ciLine = '';
  if (existsSync(workflowsDir)) {
    const workflowPath = path.join(workflowsDir, CI_WORKFLOW_FILENAME);
    if (existsSync(workflowPath)) {
      // Silently skipped, never refused. The manifest is the thing being created;
      // a workflow that is already there is the state this command wanted, and
      // failing over it would leave a half-made marketplace behind.
      debugWrite(`[marketplace] CI workflow already present at ${workflowPath} — left alone`);
      ciLine = `  ${`.github/workflows/${CI_WORKFLOW_FILENAME}`.padEnd(38)}was already there and was left alone\n`;
    } else {
      await atomicWriteFile(workflowPath, ciWorkflowText());
      ciLine = `  ${`.github/workflows/${CI_WORKFLOW_FILENAME}`.padEnd(38)}runs the check on every push\n`;
    }
  }

  process.stdout.write(
    `\n${chalk.green('Marketplace ready')} at ${toPosixPath(gitRoot)}\n\n` +
      `  ${MARKETPLACE_FILENAME.padEnd(38)}what this repository publishes (nothing yet)\n` +
      `  ${`${PACKAGES_DIR}/`.padEnd(38)}one directory per package\n` +
      ciLine +
      `\nNext: \`yg pack new <name>\` scaffolds a package, then \`yg marketplace check\`.\n\n`,
  );
}

/** Render one finding: its code, then what happened, why it matters, and what to do. */
function renderIssue(issue: MarketplaceIssue, colour: (s: string) => string): string {
  const lines = buildIssueMessage(issue.messageData).split('\n');
  return (
    `  ${colour(issue.code)}\n` +
    lines.map((line) => `    ${line}\n`).join('')
  );
}

async function runMarketplaceCheck(): Promise<void> {
  const cwd = process.cwd();
  // The manifest is what makes a directory a marketplace, so it is also what
  // locates one. When there is none anywhere above, check the directory the user
  // is standing in — so the refusal names THAT directory rather than a root they
  // never mentioned.
  const root = findUpwards(cwd, MARKETPLACE_FILENAME) ?? cwd;
  const result = await checkMarketplace(root);

  for (const issue of result.errors) process.stdout.write(renderIssue(issue, chalk.red));
  for (const issue of result.warnings) process.stdout.write(renderIssue(issue, chalk.yellow));

  const errorCount = result.errors.length;
  const warningCount = result.warnings.length;
  if (errorCount === 0 && warningCount === 0) {
    process.stdout.write(`\n${chalk.green('Ready to publish')} — ${toPosixPath(root)} passes every check.\n\n`);
  } else {
    process.stdout.write(
      `\n${errorCount} refusal${errorCount === 1 ? '' : 's'}, ` +
        `${warningCount} warning${warningCount === 1 ? '' : 's'} in ${toPosixPath(root)}.\n\n`,
    );
  }

  await exitAfterFlush(errorCount > 0 ? 1 : 0);
}

export function registerMarketplaceCommand(program: Command): void {
  const marketplace = program
    .command('marketplace')
    .description(
      'Publish rules from this repository: start a marketplace, and check it before anyone installs from it.',
    );

  marketplace
    .command('init')
    .description('Turn this git repository into a marketplace — a manifest, a packages directory, and a CI check')
    .action(async () => {
      try {
        await runMarketplaceInit();
      } catch (error) {
        debugWrite(`[marketplace] init failed: ${(error as Error).message}`);
        abortOnUnexpectedError(error, 'starting a marketplace');
      }
    });

  marketplace
    .command('check')
    .description('Check every package this repository publishes, before anyone installs one')
    .action(async () => {
      try {
        await runMarketplaceCheck();
      } catch (error) {
        debugWrite(`[marketplace] check failed: ${(error as Error).message}`);
        abortOnUnexpectedError(error, 'checking a marketplace');
      }
    });
}
