export function withNext(doc: { suggestedNext: string | null }, next: string): void {
  doc.suggestedNext = next;
}
