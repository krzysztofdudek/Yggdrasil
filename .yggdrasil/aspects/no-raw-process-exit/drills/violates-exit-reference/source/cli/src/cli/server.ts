export function stop(close: () => Promise<void>): void {
  void close().finally(process.exit);
}
