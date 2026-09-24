// A report block written in the old grammar: capitalised labels, laid out by hand.
export function renderFinding(what: string, why: string, next: string): string {
  return [`  ${what}`, `            Why: ${why}`, `            Fix: ${next}`, '', `Next: ${next}`].join('\n');
}
