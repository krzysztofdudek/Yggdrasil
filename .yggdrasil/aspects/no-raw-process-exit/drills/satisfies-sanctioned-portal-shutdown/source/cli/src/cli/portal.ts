export function onInterrupt(close: () => Promise<void>): void {
  const shutdown = (): void => {
    void close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
}
