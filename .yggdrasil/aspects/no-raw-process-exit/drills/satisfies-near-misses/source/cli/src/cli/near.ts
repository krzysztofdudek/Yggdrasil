// process.exit(1) in a comment is not a call.
const note = 'process.exit(1) in a string is not a call either';
const exitCode = process.exitCode;
const child = { exit: (code: number): number => code };

export function run(): number {
  child.exit(1);
  return exitCode ?? note.length;
}
