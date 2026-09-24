export function summary(n: number): string {
  return `${n} file${n === 1 ? '' : 's'} need coverage`;
}
