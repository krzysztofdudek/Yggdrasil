// DRILL — expected verdict: REFUSED (1 violation).
// Destructuring a credential off the parsed Commander options object with a
// default value. Must trip the rule the same as plain destructuring.
export function useKey(options: { apiKey?: string }): string {
  const { apiKey = '' } = options;
  return apiKey;
}
