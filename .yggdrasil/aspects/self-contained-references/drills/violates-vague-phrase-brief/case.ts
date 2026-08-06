// Drill case: "the brief" names no specific, findable document — a reader
// cannot tell what it refers to from this repository alone. Expected
// verdict: refused.
export function widgetLabel(): string {
  // Exactly as the brief specifies, the label is plural.
  return 'widgets';
}
