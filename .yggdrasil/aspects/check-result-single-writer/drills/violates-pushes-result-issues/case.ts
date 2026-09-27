export function addWarning(result: { issues: Array<{ code: string }> }): void {
  result.issues.push({ code: 'late-warning' });
}
