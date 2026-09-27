export function render(doc: { suggestedNext: string | null; issues: unknown[] }): number {
  return doc.issues.length + (doc.suggestedNext === null ? 0 : 1);
}
