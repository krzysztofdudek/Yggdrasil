// Guarded with Object.prototype.hasOwnProperty.call and with `key in REGISTRY`.
// Both are recognised guards. Must pass.
const REGISTRY: Record<string, number> = { a: 1, b: 2 };

export function byCall(key: string): number {
  if (Object.prototype.hasOwnProperty.call(REGISTRY, key)) return REGISTRY[key];
  return 0;
}

export function byIn(key: string): number {
  if (!(key in REGISTRY)) return 0;
  return REGISTRY[key];
}
