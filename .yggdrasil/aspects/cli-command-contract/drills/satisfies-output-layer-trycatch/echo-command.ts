// A CLI command handler that echoes its --text argument to output.
import type { Command } from 'commander';
import { abortOnUnexpectedError } from './preamble.js';
import { writeOut } from './output.js';

export function registerEchoCommand(program: Command): void {
  program
    .command('echo')
    .requiredOption('--text <value>', 'text to print back')
    .action((options: { text: string }) => {
      try {
        writeOut(`${options.text}\n`);
      } catch (error) {
        abortOnUnexpectedError(error, 'echo');
      }
    });
}
