// DRILL — expected verdict: REFUSED (1 violation).
// Destructuring a credential straight off the parsed Commander options object
// instead of reading it from process.env. Must trip the rule.
export function useKey(options: { apiKey?: string }): string {
  const { apiKey } = options;
  return apiKey ?? '';
}
