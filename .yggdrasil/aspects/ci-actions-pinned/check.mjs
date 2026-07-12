// ci-actions-pinned (advisory, errs: over)
//
// Drift protection: a GitHub Actions step that pulls in an external action via
// `uses: owner/repo` with NO `@ref` floats on that action's default branch, so
// the gate the repository depends on can change silently between runs. This
// content scan of YAML workflow files flags such a bare reference.
//
// PASS (has an explicit ref, or is not an external action):
//   - `@`-bearing refs: `actions/checkout@v4`, `owner/repo@<sha>`, a branch ref,
//     AND a reusable-workflow call `owner/repo/.github/workflows/x.yml@ref`.
//   - a local action: `./.github/actions/x` (or `../…`).
//   - a container action: `docker://alpine:3`.
//
// VIOLATION: a bare `owner/repo` (optionally with a subpath) carrying no `@ref`,
// no `./`/`../` local prefix, and no `docker://` scheme.
//
// This is text, not AST (YAML has no tree-sitter grammar here), so it
// over-approximates: any YAML value under a `uses:` key is treated as an action
// reference. Within a `ci-config` node the only YAML files are workflows, so the
// scan is precise in practice; the label stays `errs: over` and the aspect stays
// advisory because a hand-written YAML that reused a `uses:` key for another
// purpose could be falsely flagged.

// A `uses:` step key, in list-item (`- uses: …`) or mapping (`uses: …`) form.
// A leading `#` (comment) prevents the match — comments are naturally skipped.
const USES_LINE = /^\s*(?:-\s+)?uses\s*:\s*(.+?)\s*$/;

/** Extract the action reference from the raw `uses:` value (strip comment + quotes). */
function extractRef(rawValue) {
  let v = rawValue.trim();
  // Drop a trailing inline comment (` # …`). Action refs never contain ` #`.
  const hash = v.search(/\s#/);
  if (hash !== -1) v = v.slice(0, hash).trim();
  // Strip a single layer of surrounding quotes.
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

/** True when the reference carries an explicit pin, or is a local/container action. */
function isPinnedOrExempt(ref) {
  if (ref === '') return true; // empty / malformed — nothing to pin
  if (ref.startsWith('./') || ref.startsWith('../')) return true; // local action
  if (ref.startsWith('docker://')) return true; // container action
  if (ref.includes('@')) return true; // pinned to a tag / SHA / branch ref (incl. reusable workflow)
  return false; // bare owner/repo[/subpath] with no ref → unpinned
}

export function check(ctx) {
  const violations = [];

  for (const file of ctx.files) {
    if (!/\.ya?ml$/i.test(file.path)) continue; // scan YAML workflow files only

    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = USES_LINE.exec(lines[i]);
      if (!m) continue;
      const ref = extractRef(m[1]);
      if (isPinnedOrExempt(ref)) continue;

      violations.push({
        file: file.path,
        line: i + 1,
        column: 0,
        message:
          `Workflow action '${ref}' is used without a version pin. ` +
          `An unpinned action can change under you between runs — the gate you depend on ` +
          `drifts silently (drift protection, not tamper-proofing). ` +
          `Pin it to a released tag or SHA (e.g. actions/checkout@v4), or use a local ./ or docker:// reference.`,
      });
    }
  }

  return violations;
}
