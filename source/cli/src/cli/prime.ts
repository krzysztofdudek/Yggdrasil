import { Command } from 'commander';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { AGENT_RULES_CONTENT } from '../templates/rules.js';
import { digestBlockBody } from '../templates/digest.js';
import { marketplaceNoticeLine } from '../templates/knowledge/packages-and-marketplaces.js';
import type { PackageRepoKind } from '../templates/knowledge/packages-and-marketplaces.js';
import { MARKETPLACE_FILENAME, PACKAGES_LOCK_FILENAME } from '../model/packages.js';
import { cliVersion } from './cli-version.js';
import { abortOnUnexpectedError } from './preamble.js';

/**
 * Whether this repository publishes packages, consumes them, or neither.
 *
 * The probe lives HERE, in the command, because this is the layer allowed to
 * touch the disk — a knowledge document is not, and the sentence it builds takes
 * this answer as its input rather than going looking for it. Publisher is tested
 * first: a repository that is both is more likely to be asking about the packages
 * it PUBLISHES, since the ones it consumes are already covered by the rules it
 * runs against them.
 */
function packageRepoKind(cwd: string): PackageRepoKind | null {
  // Asked of the repository, not of the directory the agent happens to be in:
  // run from `src/sub`, the answer is the one the repository root gives. The
  // walk stops at the first directory that holds either marker or a graph.
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, MARKETPLACE_FILENAME))) return 'publisher';
    if (existsSync(path.join(dir, '.yggdrasil', PACKAGES_LOCK_FILENAME))) return 'consumer';
    if (existsSync(path.join(dir, '.yggdrasil'))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function registerPrimeCommand(program: Command): void {
  program
    .command('prime')
    .description('Print the agent operating manual, fresh from the installed CLI')
    .option('--digest', 'Print the standing summary block that belongs in this repository')
    .action((options: { digest?: boolean }) => {
      try {
        if (options.digest) {
          process.stdout.write(digestBlockBody(cliVersion()));
          return;
        }
        const kind = packageRepoKind(process.cwd());
        process.stdout.write(
          `Yggdrasil v${cliVersion()} — agent operating manual, printed fresh from the installed CLI.\n\n` +
            `${AGENT_RULES_CONTENT}\n` +
            (kind === null ? '' : marketplaceNoticeLine(kind)) +
            `Start with: yg check\n`,
        );
      } catch (error) {
        abortOnUnexpectedError(error, 'printing the agent manual');
      }
    });
}
