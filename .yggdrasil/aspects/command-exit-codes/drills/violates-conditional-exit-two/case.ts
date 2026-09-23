export function finish(failed: boolean): void {
  process.exit(failed ? 2 : 0);
}
