export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const idx = file.content.indexOf('TODO');
    if (idx !== -1) violations.push({ file: file.path, line: 1, column: 0, message: 'TODO marker forbidden' });
  }
  return violations;
}
