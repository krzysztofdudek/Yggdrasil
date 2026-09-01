export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const idx = file.content.indexOf('FIXME');
    if (idx !== -1) violations.push({ file: file.path, line: 1, column: 0, message: 'FIXME marker forbidden' });
  }
  return violations;
}
