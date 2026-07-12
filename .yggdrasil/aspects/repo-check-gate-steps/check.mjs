// repo-check-gate-steps (advisory, errs: over)
//
// Drift protection: the repository gate script (repo-check.sh) is the single
// binding quality gate. If a check category is quietly dropped from it, that
// whole class of regression slips through unnoticed. This check asserts that
// each expected category is still INVOKED, matching the invoked commands (not
// exact lines), so a rephrased step still counts.
//
// Categories asserted: typecheck, lint, build, test/coverage, docs build,
// markdownlint, and the graph check (`yg check`).
//
// This is text, not AST (shell has no tree-sitter grammar here). To avoid a
// keyword in a comment masking a genuinely-dropped step, the scan runs over the
// NON-COMMENT lines only (a line whose first non-space character is `#`, e.g.
// the shebang and every explanatory block, is dropped). It over-approximates
// (errs: over): a category invoked under a phrasing the matcher does not
// recognize would be falsely reported missing — hence the aspect stays
// advisory and the "next" message offers updating the aspect when the gate
// genuinely moved.
//
// This aspect deliberately does NOT assert that CI still invokes repo-check.sh —
// that residual hole is documented as uncovered by design (drift protection,
// not tamper-proofing).

/** Expected check categories. Each predicate runs against the non-comment corpus. */
const CATEGORIES = [
  { name: 'typecheck', test: (corpus) => /typecheck|\btsc\b/i.test(corpus) },
  { name: 'lint', test: (corpus) => /\blint\b|eslint/i.test(corpus) },
  { name: 'build', test: (corpus) => /\bbuild\b/i.test(corpus) },
  { name: 'test/coverage', test: (corpus) => /\btest\b|coverage/i.test(corpus) },
  // Docs build is the build step whose context names docs — require both on one line.
  { name: 'docs build', test: (_corpus, lines) => lines.some((l) => /docs/i.test(l) && /build/i.test(l)) },
  { name: 'markdownlint', test: (corpus) => /markdownlint/i.test(corpus) },
  { name: 'yg check', test: (corpus) => /\byg\s+check\b|bin\.js\s+check\b/i.test(corpus) },
];

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    // Target the gate script by basename, so a drill fixture named repo-check.sh
    // (which cannot live under scripts/) is still exercised.
    if (file.path.split('/').pop() !== 'repo-check.sh') continue;

    const lines = file.content.split('\n');
    const nonComment = lines.filter((l) => !/^\s*#/.test(l));
    const corpus = nonComment.join('\n');

    for (const category of CATEGORIES) {
      if (category.test(corpus, nonComment)) continue;
      violations.push({
        file: file.path,
        line: 1,
        column: 0,
        message:
          `The repository gate script is missing an expected step category: ${category.name}. ` +
          `repo-check.sh is the single binding gate; a dropped category lets that class of ` +
          `regression through unnoticed. ` +
          `Restore a step invoking ${category.name} in scripts/repo-check.sh; if the gate ` +
          `genuinely moved, update this aspect with the maintainer's confirmation.`,
      });
    }
  }

  return violations;
}
