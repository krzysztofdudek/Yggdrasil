// CLI command helper: reports how many reviewer pairs are still unverified.
export function reportUnverified(count: number): void {
  process.stderr.write(`Error: ${count} pairs unverified. Run yg check --approve to fix.\n`);
  process.exit(1);
}
