export const summary = 'yg-suppress inline waiver syntax: single-line, bracket disable/enable, wildcard, file-level placement';

export const content = `# Suppress syntax

\`yg-suppress\` is an inline waiver that tells the reviewer to skip a specific
aspect for a piece of code. Use it for known tech debt or intentional
exceptions — not to silence valid violations you intend to fix.

Authorization rules (when you may write a suppress, who approves the reason)
live in agent-rules.md, section "yg-suppress — Inline Aspect Waiver". This
file documents only the on-the-line syntax.

## When to suppress (briefly)

Appropriate uses:
- Brownfield code: known violation, refactor planned but not now
- Intentional exception: the rule genuinely does not apply here
- Temporary waiver: tracked in a ticket, will be resolved

Inappropriate uses:
- Silencing a violation you haven't understood yet
- Avoiding the work of fixing code that should comply
- Hiding security-relevant violations from the graph

## Single-line

The single-line form suppresses the immediately following line only.

\`\`\`typescript
// yg-suppress(security/input-validation) static config, no user input
const TIMEOUT = parseInt(process.env.TIMEOUT_MS);
\`\`\`

\`\`\`python
# yg-suppress(cqrs/single-responsibility) brownfield handler, refactor TICKET-123
def handle_order(request):
\`\`\`

\`\`\`yaml
# yg-suppress(schema/required-description) auto-generated, description added later
name: GeneratedNode
\`\`\`

The token inside the parentheses is the aspect id — its directory under
\`.yggdrasil/aspects/\` (e.g. \`security/input-validation\`); ids may be
hierarchical like \`parent/child\`. Use \`yg aspects\` to list aspect ids. A
reason must follow — it is permanent.

## Bracket

The bracket form suppresses all lines between the disable and enable markers.
Use when the exemption spans multiple lines (a function, a class, a block).

\`\`\`typescript
// yg-suppress-disable(audit-logging/emit-before-mutate) legacy path, TICKET-456
function legacyUpdate(id: string) {
  // this entire function body is suppressed
  return repo.update(id, data);
}
// yg-suppress-enable(audit-logging/emit-before-mutate)
\`\`\`

\`\`\`python
# yg-suppress-disable(legacy-pattern) brownfield, TICKET-789
def legacy_handler(request):
    return repo.update(request.id, request.data)
# yg-suppress-enable(legacy-pattern)
\`\`\`

\`\`\`sql
-- yg-suppress-disable(no-select-star) reporting query batch
SELECT * FROM users;
SELECT * FROM orders;
-- yg-suppress-enable(no-select-star)
\`\`\`

The enable marker must repeat the same aspect id as the disable marker —
only a matching enable closes the range. An enable with no open disable is
ignored, and a disable with no matching enable suppresses through to the end
of the file (this unbounded-to-EOF range is what \`yg suppressions\` flags as an
"Unbounded range" warning). The matcher does not raise an error for an
unmatched marker, so keep pairs explicit and review the resulting range
yourself. The resolved range is the same for every reviewer kind.

## Wildcard

\`*\` as the id suppresses ALL aspects (LLM and deterministic) in the range.

\`\`\`typescript
// yg-suppress-disable(*) generated code, do not edit manually
export const GENERATED_MAPPING = { ... };
// yg-suppress-enable(*)
\`\`\`

A specific \`enable(<id>)\` does NOT punch through \`disable(*)\` — the
wildcard disable covers the entire range regardless of specific enables
within it.

## File-level placement

When the entire file is exempt, use the bracket form at the file level
(outside any function or class): a \`yg-suppress-disable(<id>)\` near the top
and a matching \`yg-suppress-enable(<id>)\` at the end. A bare
\`yg-suppress-disable(<id>)\` with no enable also covers through to the end of
the file, but the explicit pair is preferred so the range is unambiguous.

Do NOT reach for the single-line \`yg-suppress(<id>)\` to waive a whole file —
it covers only the one line that follows it. This is true for EVERY aspect kind:
suppress scope is resolved once, deterministically, into line ranges, and BOTH
reviewer kinds honor the exact same ranges. A deterministic \`check.mjs\` reads
those ranges directly; an LLM aspect's reviewer receives them injected into its
prompt (as resolved \`(start-line, end-line)\` spans) and is instructed to honor
exactly those lines — it does not re-interpret the marker's scope. So a
single-line marker waives one line for an LLM aspect just as it does for a
deterministic one. To waive a whole file, use the \`disable\`/\`enable\` bracket
(or a bare \`disable\` that runs to end of file) — never a single-line marker.

## Language support

Markers are recognized in any source language, using whichever comment syntax
the language provides — \`//\` and \`/* */\` (C-family), \`#\` (shell, Python),
\`--\` (SQL), and so on. The marker token \`yg-suppress(...)\` is what is matched,
not a specific comment style — but only in the anchored position described below.

A marker must be anchored: the \`yg-suppress...\` token must be the first thing
on its comment line — only whitespace and a single leading comment delimiter
(\`//\`, \`/*\`, \`*\`, \`#\`, \`--\`, \`;\`, \`<!--\`, ...) may precede it. Prose
that merely mentions the syntax mid-sentence, a backtick-quoted
\`yg-suppress(...)\`, or a marker-shaped token following code on the same line
is NOT a marker — it is neither honored by any reviewer nor listed by
\`yg suppressions\`.

For a file whose extension has a registered grammar, markers are read from the
file's comments, so a \`yg-suppress(...)\` that merely appears inside a string
literal is NOT treated as a marker. For a file whose extension has no registered
grammar (e.g. \`.sql\`, \`.md\`, \`.sh\`), there is no parse tree, so markers are
found by scanning the raw lines — which is what lets a content-only deterministic
check waive a violation in such a file. In this raw-scan mode the marker line
must still BEGIN with a comment delimiter (\`#\`, \`--\`, \`<!--\`, \`;\`, ...):
a bare line that merely starts with the token — a wrapped prose sentence or a
string-literal line with no delimiter — is NOT a marker. A real
\`# yg-suppress(...)\` / \`-- yg-suppress(...)\` / \`<!-- yg-suppress(...) -->\`
still works.

## Markdown

A Markdown file (\`.md\` / \`.markdown\`) has no code grammar, so its markers come
from the raw-line scan. A marker written INSIDE a fenced code block — between
\`\`\` … \`\`\` or ~~~ … ~~~ delimiters — is a documented EXAMPLE, not a live
waiver: it is NOT honored by any reviewer and NOT listed by \`yg suppressions\`.
This lets a page SHOW the suppress syntax without silently waiving a real rule.
An unclosed fence is treated as running to the end of the file, so a marker after
it is inert too — any fence ambiguity fails toward enforcement, so a fenced
example is only ever skipped, never honored.

To place a GENUINE, honored suppress marker in a Markdown file, use an HTML
comment OUTSIDE any fence — it waives the line that follows it, exactly like a
single-line marker in code:

\`\`\`markdown
<!-- yg-suppress(<aspect-id>) <reason> -->
the line this waives
\`\`\`

Out of scope (no special handling): a 4-space-indented code block is NOT masked,
and a marker on a bare prose line is already inert (the raw-line scan requires a
leading comment delimiter). Only fenced blocks are recognized as inert examples.

## Reason text

The reason text after the aspect-id is permanent. Future maintainers and
agents will read it to understand why the waiver exists. Do not invent
reasons — see the authorization rules in agent-rules.md.

## Effect on verification

The reviewer honors suppress unconditionally. A suppressed line or range
does not generate a violation, even if the code clearly violates the aspect.
The suppression is an explicit human decision recorded in the code.

Suppressing a draft aspect is a no-op: a draft aspect produces no expected pairs,
so there is nothing to waive. Only suppress aspects whose effective status is
advisory or enforced.

## What cannot be suppressed

\`yg-suppress\` waives ASPECTS. It has no effect on the built-in checks that are
not aspects — the architecture and mapping validators, and the relation-conformance
check (\`relation-undeclared-dependency\`, see
\`yg knowledge read ports-and-relations\`). The relation-conformance check has no
aspect id to name in a marker and is always an error; a \`yg-suppress\` aimed at it
is inert. Resolve a relation refusal by declaring the relation in the node's
\`yg-node.yaml\` or removing the dependency — never by trying to suppress it.

A suppress marker (single or disable form) must carry a reason — an empty
reason is rejected with a clear error. Beyond that, the token is matched as a
plain string against the aspect id being checked: there is NO validation
that the id names an existing aspect, so a typo simply suppresses nothing
(the marker is inert). Nothing validates that the reason is sufficient.
`;
