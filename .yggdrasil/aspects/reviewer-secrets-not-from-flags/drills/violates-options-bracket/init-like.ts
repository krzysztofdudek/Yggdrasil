// DRILL — expected verdict: REFUSED (1 violation).
// Reading a credential off the parsed Commander options object via bracket
// access instead of process.env. Must trip the rule.
export function useKey(options: Record<string, string | undefined>): string {
  return options['apiKey'] ?? '';
}
