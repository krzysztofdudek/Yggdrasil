export function stampAt(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
