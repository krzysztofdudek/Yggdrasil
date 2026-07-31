// Drill case: a "Step N: ..." IN-FILE algorithm section marker in an
// ordinary comment (not a test name) — the real shape this repository's own
// fill.ts/pairs.ts use to divide a long function into numbered stages,
// defined and read entirely within this file. The step check (PART C) scans
// test names only, so a comment can never trigger it regardless of shape.
// Expected verdict: satisfied.
export function widgetCount(items: unknown[]): number {
  // Step 1: validate the input is actually an array before counting it.
  if (!Array.isArray(items)) return 0;
  // Step 2: count every item, including falsy ones — length is exact.
  return items.length;
}
