export function finish(failed: boolean): void {
  process.exit(failed ? 1 : 0);
}
