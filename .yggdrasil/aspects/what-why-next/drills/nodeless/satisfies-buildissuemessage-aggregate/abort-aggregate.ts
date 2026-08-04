// CLI command action: aborts when the requested aspect id is an aggregate with no rule source of its own.
import { buildIssueMessage } from '../formatters/message-builder.js';

export function abortAggregateHasNoRuleSource(aspectId: string): never {
  process.stderr.write(
    `Error: ${buildIssueMessage({
      what: `Aspect '${aspectId}' is an aggregate and has no rule source of its own.`,
      why: 'An aggregate only bundles other aspects; it has no check.mjs or content.md to run, so there is nothing to test or drill directly.',
      next: `Run the command again against one of the aggregate's implied atomic aspect ids instead.`,
    })}\n`,
  );
  process.exit(1);
}
