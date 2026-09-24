// CLI command helper: reports how many reviewer pairs are still unverified.
import { buildIssueMessage } from '../formatters/message-builder.js';
import { count } from './output.js';

export function reportUnverified(n: number): void {
  // buildIssueMessage renders the labelled grammar: what, then `why:`, then `next:`.
  process.stderr.write(
    `${buildIssueMessage({
      what: `${count(n, 'pair')} unverified.`,
      why: 'An unverified pair means the reviewer has not checked the current code against the rule, so the build cannot be trusted as green.',
      next: 'yg check --approve',
    })}\n`,
  );
  process.exit(1);
}
