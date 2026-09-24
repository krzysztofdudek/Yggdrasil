export async function refused(word: string): Promise<string> {
  const { default: chalk } = await import('chalk');
  return chalk.red(word);
}
