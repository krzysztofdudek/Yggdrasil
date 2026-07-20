// A Map has no string-keyed prototype members to inherit, so a dynamic lookup is
// safe. The registry is not an object literal, so it is never a subject. Must pass.
const REGISTRY = new Map<string, number>([
  ['a', 1],
  ['b', 2],
]);

export function lookup(key: string): number {
  return REGISTRY.get(key) ?? 0;
}
