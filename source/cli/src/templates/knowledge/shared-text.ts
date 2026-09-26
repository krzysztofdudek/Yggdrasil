/**
 * Sentences more than one agent surface has to say word for word.
 *
 * An agent reads the operating manual (`yg prime`) every session and the
 * knowledge topics on demand. When two of them describe one behaviour in two
 * hand-written copies, a change to the behaviour updates one copy and the agent
 * is told two different things. So a sentence that several topics need is
 * written once here and interpolated where it is used; the operating manual
 * cannot import it (its template module sits in another layer), so a unit test
 * holds the manual's copy to these exact strings instead.
 *
 * Each export is one paragraph on one line, so it reads the same in a
 * hard-wrapped topic and in the manual's one-line paragraphs.
 */

/**
 * When bare `yg check` stays read-only even though `auto_approve` asks for a
 * fill: a committed `full` under CI, and every triage view.
 */
export const AUTO_APPROVE_READ_ONLY_CASES =
  'Two cases stay read-only whatever `auto_approve` says. When the `CI` environment variable is set (to anything but empty, `0` or `false`), a committed `full` is held back: bare `yg check` fills nothing — no reviewer pair and no script pair — calls no reviewer, and says `auto-approve: full ignored — CI is set` on stderr; an explicit `--approve` still fills, and `deterministic` still fills the script pairs under CI. And a triage view (`--top`, `--summary`, `--aspect`, `--details`) never fills, whatever the configuration.';

/** What besides the rule file itself is folded into a rule's hash. */
export const RULE_SUPPORT_FILES =
  "A rule is more than its rule file: every other file in the rule's directory is folded into the rule's hash too — a helper module `check.mjs` or `companion.mjs` imports, a table it ships — so editing one re-opens every pair of the rule, exactly as editing `content.md` or `check.mjs` does. Left out: `yg-aspect.yaml`, `log.md`, a package rule's adaptation and its log, a generator's `provenance.json`, `node_modules`, and every file under a dot-named entry that is not code (`.mjs`, `.js`, `.cjs`); a file under `drills/` or in a nested rule's directory counts only when the rule's code names it by a literal relative specifier (an `import`, `require` or `new URL(…, import.meta.url)`), and a gitignored dot-named file never counts. A module imported from outside the rule's directory is not folded in.";

/** Which line a single-line `yg-suppress` marker waives, trailing markers included. */
export const SUPPRESS_SINGLE_LINE_SCOPE =
  'A single-line marker waives exactly one line: the line directly below it — or, when its comment trails code on the same line (`doThing(); // yg-suppress(<aspect-path>) <reason>`), that line itself, never the one below. A trailing `yg-suppress-disable` opens its range on its own line, and a trailing `yg-suppress-enable` closes it after its own line. A trailing marker is read only in a file whose language has a registered grammar; anywhere else, put the marker on its own line, directly above the line it waives. `yg suppressions` prints the lines each marker actually waives.';
