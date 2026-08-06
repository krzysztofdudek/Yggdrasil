// Drill case: a vague, unresolvable reference split across two wrapped
// comment lines — the failure mode a line-based grep misses because the
// phrase "this task" never appears whole on any single line. Expected
// verdict: refused (the two lines must be joined before matching).
export function widgetCount(items: unknown[]): number {
  // src/unclassified/x.ts matches no architecture type — this
  // task must not change that behavior.
  return items.length;
}
