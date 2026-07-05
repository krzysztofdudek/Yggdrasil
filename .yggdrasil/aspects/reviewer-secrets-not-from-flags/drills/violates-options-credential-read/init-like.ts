// DRILL — expected verdict: REFUSED (1 violation).
// Reading a credential value off the parsed Commander options object instead of
// process.env. Must trip the rule.
export function useKey(options: { apiKey?: string }): string {
  return options.apiKey ?? '';
}
