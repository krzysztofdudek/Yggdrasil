const MAX_DESC = 80;

export function truncateDescription(s: string): string {
  if (s.length <= MAX_DESC) return s;
  const slice = s.slice(0, MAX_DESC);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return cut.trimEnd() + '...';
}
