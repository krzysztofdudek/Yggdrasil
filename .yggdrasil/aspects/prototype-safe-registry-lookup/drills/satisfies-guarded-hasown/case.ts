// Guarded with Object.hasOwn — the correct fix. Must pass.
const REGISTRY: Record<string, number> = { a: 1, b: 2 };

export function lookup(key: string): number {
  if (Object.hasOwn(REGISTRY, key)) return REGISTRY[key];
  return 0;
}
