// Deterministic aspect: elevated-audit
//
// An admin-only handler reverses or overrides something an ordinary handler
// cannot — a role check has to run before it does. The rule is satisfied
// when the file calls requireRole( before performing the admin action.

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.path.endsWith('.ts')) continue;
    if (/\brequireRole\s*\(/.test(file.content)) continue;

    violations.push({
      file: file.path,
      line: 1,
      column: 0,
      message:
        "Admin handler does not check the caller's role: call " +
        'requireRole(actor, role) before performing the admin action.',
    });
  }

  return violations;
}
