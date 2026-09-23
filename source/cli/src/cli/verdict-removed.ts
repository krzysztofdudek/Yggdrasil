import { Command } from 'commander';
import { abortOnUnexpectedError } from './preamble.js';
import { fail } from './output.js';

/**
 * `yg verdict` (package / record / read) was the external-judge channel: a way
 * to record a judgement on a prose rule without running the configured
 * reviewer. It is gone — the reviewer configured in yg-config.yaml, through
 * `yg check --approve`, is the only judge. The name stays registered, hidden
 * from help, so a script, a CI job or an agent still calling it is told what
 * happened and where to go instead of getting a bare unknown-command error.
 * It never reads or writes anything and always fails.
 */
export function registerRemovedVerdictCommand(program: Command): void {
  program
    .command('verdict', { hidden: true })
    .description('Removed — prose rules are judged only by the configured reviewer, through yg check --approve')
    .argument('[args...]')
    .allowUnknownOption()
    .helpOption(false)
    .action(() => {
      try {
        fail({
          what: 'yg verdict (package, record, read) was removed in 6.1.0.',
          why: 'A prose rule is judged by the reviewer configured in .yggdrasil/yg-config.yaml and by nothing else, so there is no channel for recording a judgement from outside it. Verdicts an earlier release recorded that way are still read and still hold while the code they judged is unchanged.',
          next: 'Record verdicts with: yg check --approve (configure the reviewer first with yg init --provider <name> [--model <m>] if none is set).',
        });
      } catch (error) {
        abortOnUnexpectedError(error, 'reporting the removed verdict command');
      }
      process.exit(1);
    });
}
