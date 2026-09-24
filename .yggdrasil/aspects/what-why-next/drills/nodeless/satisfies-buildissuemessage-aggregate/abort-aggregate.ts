// CLI command action: aborts when the requested aspect id is an aggregate with no rule source of its own.
import { fail } from './output.js';

export function abortAggregateHasNoRuleSource(aspectId: string): never {
  fail({
    what: `Aspect '${aspectId}' is an aggregate and has no rule source of its own.`,
    why: 'An aggregate only bundles other aspects; it has no check.mjs or content.md to run, so there is nothing to test or drill directly.',
    next: `yg aspects — then run the command again against one of the aggregate's implied atomic aspect ids.`,
  }, 'usage');
  process.exit(1);
}
