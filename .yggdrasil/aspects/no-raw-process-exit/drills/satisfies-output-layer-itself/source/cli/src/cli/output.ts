export function failAndExit(what: string): never {
  process.stderr.write(`error: ${what}\n`);
  process.exit(1);
}
