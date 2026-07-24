import { Command } from 'commander';
import { AGENT_RULES_CONTENT } from '../templates/rules.js';
import { digestBlockBody } from '../templates/digest.js';
import { cliVersion } from './cli-version.js';
import { abortOnUnexpectedError } from './preamble.js';

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
        process.stdout.write(
          `Yggdrasil v${cliVersion()} — agent operating manual, printed fresh from the installed CLI.\n\n` +
            `${AGENT_RULES_CONTENT}\n` +
            `Start with: yg check\n`,
        );
      } catch (error) {
        abortOnUnexpectedError(error, 'printing the agent manual');
      }
    });
}
