// Deliberately refuses ONLY on src/leaf/a.ts, never on any other file — so a
// test using this variant can assert that a.ts's refusal never suppresses
// review of b.ts (or any other file matching the same type).
export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (file.path === 'src/leaf/a.ts') {
      violations.push({
        file: file.path,
        line: 1,
        column: 0,
        message: 'Deliberately refuses only on a.ts.',
      });
    }
  }
  return violations;
}
