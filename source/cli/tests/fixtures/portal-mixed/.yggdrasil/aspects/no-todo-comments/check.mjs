import { findComments } from '@chrisdudek/yg/ast';

// A focused, real deterministic aspect for the portal-basic fixture: ship no TODO / FIXME
// marker in a comment. Comment-based (uses the AST comment scanner), so a TODO appearing
// in a normal string or identifier is not a false positive.

const MARKER_RE = /\b(TODO|FIXME)\b/;

export function check(ctx) {
  const violations = [];
  for (const file of ctx.files) {
    if (!file.ast) continue;
    for (const comment of findComments(file)) {
      const m = MARKER_RE.exec(comment.text);
      if (m) {
        violations.push({
          file: file.path,
          line: comment.startPosition.row + 1,
          column: comment.startPosition.column,
          message: `Comment contains a '${m[1]}' marker. Track outstanding work in the issue tracker, not in code.`,
        });
      }
    }
  }
  return violations;
}
