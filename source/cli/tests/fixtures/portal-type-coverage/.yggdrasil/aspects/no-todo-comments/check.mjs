// A real deterministic aspect: source must not ship a TODO / FIXME marker
// anywhere in its text. Plain-text (not AST-based) so it needs no parser —
// this fixture's only job is to prove a type-covered file gets a genuine,
// live verdict, not to exercise the comment scanner. Attached only to the
// fixture's classifying type (svc) — its one type-covered file ships a FIXME
// on purpose, so this fixture carries a real, live refusal on a file no node
// maps.

const MARKER_RE = /\b(TODO|FIXME)\b/;

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = MARKER_RE.exec(lines[i]);
      if (m) {
        violations.push({
          file: file.path,
          line: i + 1,
          column: m.index,
          message: `Line contains a '${m[1]}' marker. Track outstanding work in the issue tracker, not in code.`,
        });
      }
    }
  }
  return violations;
}
