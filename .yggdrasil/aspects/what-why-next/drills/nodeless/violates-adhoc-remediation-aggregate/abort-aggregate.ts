// CLI command action: aborts when the requested aspect id is an aggregate with no rule source of its own.
export function abortAggregateHasNoRuleSource(aspectId: string): never {
  process.stderr.write(`Error: '${aspectId}' is an aggregate. Pick one of its implied aspect ids and try again.\n`);
  process.exit(1);
}
