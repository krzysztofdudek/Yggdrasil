/**
 * source/cli/src/core/drill-add.ts — planning the one way a real case enters a
 * rule's corpus.
 *
 * A corpus is at its most valuable when it holds the code that actually got
 * past the rule, not a synthetic imitation of it. That means taking a file as it
 * stood at a named commit and putting it in as a case. Everything about that is
 * decided here, and nothing here touches git, the filesystem or the clock: the
 * command boundary reads the file at the commit and writes the case; this module
 * says what the case is called, whether it is already there, and what gets
 * recorded about it.
 *
 * Two decisions carry the weight:
 *
 *  - THE NAME CARRIES THE ORIGIN. A case called `violates-charge-20260906-3a351e1`
 *    tells the next reader which file, which day and which commit it came from,
 *    so a fixture can always be traced back to the incident behind it. The
 *    verdict prefix stays exactly the corpus convention every reader already
 *    knows, because a name that carries provenance must still be a case name.
 *  - THE SAME BYTES NEVER ENTER TWICE. A second copy of a case measures nothing
 *    new; it only inflates a corpus count that people read as coverage. Sameness
 *    is byte equality, not name equality — the same code taken from two commits
 *    is one case, and a name is not evidence.
 */

import type { CorpusFile } from '../io/drill-corpus-store.js';
import type { IssueMessage } from '../model/validation.js';

/** What a case-spec argument (`<path>@<commit>`) resolved to. */
export type CaseSpecResult =
  | { ok: true; filePath: string; ref: string }
  | { ok: false; error: IssueMessage };

/**
 * Split `<path>@<commit>` into its two halves.
 *
 * The split is on the LAST `@`, so a path that legitimately contains one (a
 * scoped package directory, say) still resolves — the commit half never does.
 */
export function parseCaseSpec(spec: string, flag: string): CaseSpecResult {
  const at = spec.lastIndexOf('@');
  const filePath = at === -1 ? '' : spec.slice(0, at).trim();
  const ref = at === -1 ? '' : spec.slice(at + 1).trim();
  if (filePath === '' || ref === '') {
    return {
      ok: false,
      error: {
        what: `${flag} '${spec}' is not a file at a commit.`,
        why: 'A case comes from code that really existed: the file, and the commit it stood at. Without both there is nothing to read and nothing to record about where the case came from.',
        next: `Re-run with ${flag} <path>@<commit>, e.g. ${flag} src/billing/charge.ts@a1b2c3d.`,
      },
    };
  }
  if (filePath.startsWith('/') || filePath.split('/').includes('..')) {
    return {
      ok: false,
      error: {
        what: `${flag} path '${filePath}' is not inside the repository.`,
        why: 'The file is read out of the repository at that commit, so its path is repository-relative; an absolute path or one that climbs out names something the commit does not contain.',
        next: `Re-run with the path as it appears in the repository, e.g. ${flag} src/billing/charge.ts@a1b2c3d.`,
      },
    };
  }
  return { ok: true, filePath, ref };
}

/**
 * The part of the case name taken from the file itself: its base name without
 * the extension, reduced to what reads cleanly in a directory name.
 *
 * A name that survives this as empty (a file called `.env`, say) falls back to
 * a fixed word rather than producing a case whose name begins with a dash.
 */
export function slugFor(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  const stem = base.replace(/\.[^.]+$/, '');
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'case' : slug;
}

/**
 * The case's directory name: the verdict it expects, what it is, the day the
 * code was written, and the commit it came from.
 *
 * The date is the commit's own day, not today's: what matters to a later reader
 * is when the code existed, not when somebody got around to filing it.
 */
export function caseLabelFor(args: {
  expect: 'violates' | 'satisfies';
  filePath: string;
  commitDate: string;
  commitSha: string;
}): string {
  const day = args.commitDate.replace(/-/g, '');
  const short = args.commitSha.slice(0, 7);
  return `${args.expect}-${slugFor(args.filePath)}-${day}-${short}`;
}

/**
 * The case already holding these exact bytes, or null when the corpus has none.
 *
 * Byte equality is the whole test: the same code arriving under a different name,
 * or from a different commit, is the same case.
 */
export function duplicateOf(content: string, corpus: readonly CorpusFile[]): CorpusFile | null {
  const bytes = Buffer.from(content, 'utf8');
  for (const file of corpus) {
    if (file.content.equals(bytes)) return file;
  }
  return null;
}

/**
 * The entry recorded in the rule's own log for a case that stayed.
 *
 * It states the facts — which file, which commit, what the case expects, and
 * what the rule did when it was run over it — and then the reason the person
 * gave. When they gave none it says so plainly rather than inventing one: a log
 * that fabricates a rationale is worse than a log that admits it has none.
 */
export function caseLogEntry(args: {
  caseLabel: string;
  filePath: string;
  commitSha: string;
  commitDate: string;
  expect: 'violates' | 'satisfies';
  caught: boolean;
  why: string | null;
}): string {
  const verdict = args.expect === 'violates'
    ? args.caught
      ? 'The rule refuses it, so this case now guards against that behaviour coming back.'
      : 'The rule does NOT refuse it: the case is in the corpus as a standing record of a hole the rule still has.'
    : args.caught
      ? 'The rule wrongly refuses it, so the case is in the corpus as a standing record of a false alarm the rule still raises.'
      : 'The rule passes it, so this case now guards against the rule starting to refuse code it should allow.';
  const reason = args.why === null
    ? 'No reason was given when the case was added.'
    : args.why;
  return [
    `Took \`${args.filePath}\` as it stood at commit ${args.commitSha} (${args.commitDate}) into this rule's case corpus as \`${args.caseLabel}\`, which the rule is expected to ${args.expect === 'violates' ? 'refuse' : 'pass'}. ${verdict}`,
    '',
    reason,
  ].join('\n');
}
