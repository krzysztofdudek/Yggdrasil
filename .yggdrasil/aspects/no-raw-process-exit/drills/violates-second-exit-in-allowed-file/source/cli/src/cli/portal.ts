export function shutdown(close: () => Promise<void>): void {
  void close().finally(() => process.exit(0));
}

export function refuse(): void {
  process.exit(1);
}
