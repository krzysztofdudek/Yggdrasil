// Drill case: an ordinary, fully self-contained comment with no reference to
// anything outside this repository. Expected verdict: satisfied.
export function widgetCount(items: unknown[]): number {
  // Counts every item in the list, including falsy ones — length is exact.
  return items.length;
}
