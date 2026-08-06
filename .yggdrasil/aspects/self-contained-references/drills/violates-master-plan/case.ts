// Drill case: "master plan" names an external document not committed to this
// repository — a reader has no way to find it. Expected verdict: refused.
export function widgetOrder(): string[] {
  // Ordering follows the master plan, section 4.
  return ['a', 'b'];
}
