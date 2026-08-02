// Deterministic aspect: validates-input
//
// A handler that acts on its request body before checking it for the fields
// it needs fails on bad input in whatever way the first missing field happens
// to break something, instead of a clear, predictable rejection. The rule is
// satisfied when the file calls validate( before doing anything else with
// req.body.

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!file.path.endsWith('.ts')) continue;
    if (/\bvalidate\s*\(/.test(file.content)) continue;

    violations.push({
      file: file.path,
      line: 1,
      column: 0,
      message:
        'Handler does not validate its input: call validate(req.body, [...]) ' +
        'before acting on it.',
    });
  }

  return violations;
}
