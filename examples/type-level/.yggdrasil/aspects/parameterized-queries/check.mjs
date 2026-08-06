// Deterministic aspect: parameterized-queries
//
// A query(sql) call with no second argument has nowhere to put a bound
// value, which means the SQL string itself was built with the value already
// in it — the exact shape of a SQL-injection bug. The rule is satisfied
// when every query( call passes a second, comma-separated argument (the
// bound parameters), never a single bare SQL string.

export function check(ctx) {
  const violations = [];
  const singleArgCall = /\bquery\s*\(\s*[^,()]*\)/g;

  for (const file of ctx.files) {
    if (!file.path.endsWith('.ts')) continue;

    let match;
    while ((match = singleArgCall.exec(file.content)) !== null) {
      const line = file.content.slice(0, match.index).split('\n').length;
      violations.push({
        file: file.path,
        line,
        column: 0,
        message:
          'query(...) is called with no bound-parameters argument: build it as ' +
          "query(sql, params) so values are never concatenated into the SQL string.",
      });
    }
  }

  return violations;
}
