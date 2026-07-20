// Object.create(null) has no prototype, so no inherited key can be reached. The
// initializer is a call, not an object literal, so it is never a subject. Must pass.
const REGISTRY: Record<string, number> = Object.create(null);
REGISTRY.a = 1;
REGISTRY.b = 2;

export function lookup(key: string): number {
  return REGISTRY[key] ?? 0;
}
