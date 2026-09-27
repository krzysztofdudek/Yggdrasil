export function collect(found: string[]): Array<{ code: string }> {
  const issues: Array<{ code: string }> = [];
  for (const code of found) issues.push({ code });
  return issues;
}
