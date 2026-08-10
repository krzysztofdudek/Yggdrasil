export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const idx = file.content.indexOf('console.log');
    if (idx !== -1) violations.push({ file: file.path, line: 1, column: 0, message: 'console.log call forbidden' });
  }
  return violations;
}
