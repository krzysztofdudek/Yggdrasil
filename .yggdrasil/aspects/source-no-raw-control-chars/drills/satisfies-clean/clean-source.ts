// Drill case: a clean source file. It even puts a NUL into a string the
// COMPLIANT way — as the escape sequence `\0` (ordinary ASCII), not a raw byte.
// Expected verdict: satisfied (no raw control byte anywhere in the file).
export const nulTerminator = '\0';
export const greeting = 'hello\tworld\n';

export function build(): string {
  return `${greeting}${nulTerminator}`;
}
