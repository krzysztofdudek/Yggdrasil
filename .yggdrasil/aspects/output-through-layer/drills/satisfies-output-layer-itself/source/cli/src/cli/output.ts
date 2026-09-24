import chalk from 'chalk';

export function writeOut(text: string): boolean {
  return process.stdout.write(text);
}

export const paint = { red: (t: string): string => chalk.red(t) };

export function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}
