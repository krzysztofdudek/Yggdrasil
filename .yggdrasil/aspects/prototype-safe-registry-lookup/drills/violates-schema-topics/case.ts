// Reproduces the SCHEMA_TOPICS bug: a `?? ` fallback is NOT a guard — the
// inherited value is truthy, so it wins over the fallback.
const SCHEMA_TOPICS: Record<string, string> = {
  node: 'node schema',
  aspect: 'aspect schema',
};

export function schema(name: string): string {
  return SCHEMA_TOPICS[name] ?? 'unknown schema';
}
