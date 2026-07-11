// CLI command helper: reports how many reviewer pairs are still unverified.
import { buildIssueMessage } from '../formatters/message-builder.js';

export function reportUnverified(count: number): void {
  process.stderr.write(
    `Error: ${buildIssueMessage({
      what: `${count} pair(s) are unverified.`,
      why: 'An unverified pair means the reviewer has not checked the current code against the rule, so the build cannot be trusted as green.',
      next: 'Run `yg check --approve` to fill the unverified pairs.',
    })}\n`,
  );
  process.exit(1);
}
