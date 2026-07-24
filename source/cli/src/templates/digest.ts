/**
 * Canonical committed digest — the small, standing block yg init writes into
 * AGENTS.md (between the yggdrasil markers) and into .clinerules/yggdrasil.md.
 * WHAT: mandate to run `yg prime` + the invariants no reviewer can enforce.
 * WHY:  the full manual lives in the installed CLI (yg prime), so the repo
 *       carries only this hash-anchored summary; yg check compares the anchor
 *       hash against this canonical body to detect stale/modified digests.
 * Hand-tuned like rules.ts — do not generate programmatically.
 */
import { createHash } from 'node:crypto';

// prettier-ignore
export const DIGEST_BODY = `## Yggdrasil

This repository is managed by Yggdrasil — continuous architecture enforcement.
An architecture graph in \`.yggdrasil/\` defines the rules; a reviewer verifies
source code against them, and \`yg check\` blocks CI whenever an enforced rule
is violated or unverified.

**Required first step:** run \`yg prime\` and follow the protocol it prints
before making any change. The full, current operating manual comes from the
installed CLI — this block is only the standing summary. If \`yg prime\` is not
a recognized command, the installed Yggdrasil CLI predates this integration:
update the \`@chrisdudek/yg\` package before proceeding.

Non-negotiable invariants (they hold even before reading the manual):

- Never write a \`yg-suppress\` marker without the user's explicit
  confirmation. The reviewer honors suppressions unconditionally — an
  unauthorized suppress silently disables a rule.
- Never change a rule's \`review_by:\` date; renewing or retiring a rule is
  the user's decision.
- Treat \`yg advise\` items and incidents as proposals: dismissing, deferring,
  or recording one requires the user's approval. Never fabricate an incident.
- Changes to \`.yggdrasil/yg-architecture.yaml\` require the user's
  confirmation.
- Log entries (\`yg log add\`) carry WHY in self-contained prose — no
  references to plans, file paths, steps, or conversation state.
- Never hand-edit \`.yggdrasil/\` lock files.
- If the user explicitly requests a code-only change without graph updates,
  comply but warn: the affected rules stay unverified and CI stays red. Do
  not run \`yg check --approve\` — leave the rules unverified.

Start every session with \`yg check\`; re-print the manual any time with
\`yg prime\`.
`;

/**
 * Lenient READER for an anchor line — `<!-- yggdrasil:digest cli=<version>
 * sha256=<hex> -->` — pulling its `cli` and `sha256` fields out of arbitrary
 * surrounding text. Unanchored on purpose: its callers hold a whole file (or a
 * command's whole stdout) and want the anchor wherever it sits.
 *
 * It is NOT the staleness gate's parser and must not become one: judging an
 * installed anchor needs a whole-LINE match, which `core/checks/digest-gate`
 * does with its own strictly anchored expression. Two expressions, two jobs —
 * a lenient reader here, a strict judge there.
 */
export const ANCHOR_RE =
  /<!-- yggdrasil:digest cli=(?<cli>[^ ]+) sha256=(?<sha256>[0-9a-f]{64}) -->/;

/** sha256 over the LF-normalized body — CRLF checkouts must hash identically. */
export function digestSha256(body: string = DIGEST_BODY): string {
  return createHash('sha256').update(body.replace(/\r\n/g, '\n'), 'utf-8').digest('hex');
}

/** The gate anchor for the current CLI version. `cli=` is informational only —
 *  every comparison (gate, repo-check) keys on `sha256` alone. */
export function digestAnchor(cliVersion: string): string {
  return `<!-- yggdrasil:digest cli=${cliVersion} sha256=${digestSha256()} -->`;
}

/** Content INSIDE the AGENTS.md markers; also the full content of
 *  .clinerules/yggdrasil.md. */
export function digestBlockBody(cliVersion: string): string {
  return `${digestAnchor(cliVersion)}\n${DIGEST_BODY}`;
}
