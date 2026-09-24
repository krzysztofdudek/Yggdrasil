/**
 * source/cli/src/utils/bounded-map.ts — run an async function over a list with
 * at most `limit` calls in flight, results in input order.
 *
 * For file I/O over a whole repository: one awaited call at a time leaves a run
 * waiting on the disk, and all of them at once can exhaust file descriptors
 * (a failed open would then read as an unreadable file). A small fixed window
 * keeps the disk busy without either.
 */
export const IO_CONCURRENCY = 64;

export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, lane));
  return results;
}
