import { findComments } from '@chrisdudek/yg/ast';

// A second, independent deterministic aspect for the portal-mixed fixture — advisory
// status, so its pairs carry warning severity while no-todo-comments (enforced) carries
// error severity on the SAME two nodes. Narrower than no-todo-comments's marker (FIXME
// only), so it is a genuinely distinct check, not a copy wearing a new status.

const MARKER_RE = /\bFIXME\b/;

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
          message: `Comment contains a 'FIXME' marker. Track outstanding work in the issue tracker, not in code.`,
        });
      }
    }
  }
  return violations;
}
