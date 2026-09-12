// A rule this repository wrote itself. It exists so the backward-compatibility
// fixture has real law of its own: a repository with no rules would have no
// verdicts either, and "an existing verdict still holds" would prove nothing.
export function check(ctx) {
  const violations = [];
  for (const file of ctx.subject) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('TODO')) {
        violations.push({ file: file.path, line: i + 1, message: 'TODO comment found.' });
      }
    }
  }
  return violations;
}
