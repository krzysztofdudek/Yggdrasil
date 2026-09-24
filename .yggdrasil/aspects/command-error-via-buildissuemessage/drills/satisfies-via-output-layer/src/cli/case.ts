import chalk from 'chalk';
import { fail, block } from './output.js';

export function refuseMissingNode(nodePath: string): void {
  fail({
    what: `Node '${nodePath}' does not exist in the graph.`,
    why: 'The command needs an existing node to resolve its rules and files.',
    next: 'yg tree',
  }, 'node-not-found');
}

export function failHelper(summary: string): void {
  process.stderr.write(chalk.red(block({ what: summary, why: 'reason', next: 'fix it' })) + '\n');
}
