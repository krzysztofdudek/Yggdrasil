// A count whose noun cannot agree with its number: "1 pair(s)".
export function unverifiedLine(n: number): string {
  return `  ${n} unverified pair(s) — run the fill to record them\n`;
}
