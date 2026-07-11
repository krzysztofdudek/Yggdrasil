// A CLI command handler that echoes its --text argument to output.
import type { Command } from 'commander';

export function registerEchoCommand(program: Command): void {
  program
    .command('echo')
    .requiredOption('--text <value>', 'text to print back')
    .action((options: { text: string }) => {
      console.log(options.text);
      if (options.text.length === 0) {
        console.error('nothing to echo');
      }
    });
}
