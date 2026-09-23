import chalk from 'chalk';

export function refuse(detail: (s: string) => string): void {
  // `detail(` and `onfail(` are not the output layer's helpers.
  const onfail = (s: string): string => s;
  process.stderr.write(chalk.red(`Error: ${onfail(detail('something broke'))}`) + '\n');
}
