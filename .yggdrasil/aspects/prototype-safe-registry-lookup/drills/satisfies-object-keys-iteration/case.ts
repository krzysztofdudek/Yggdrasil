// The key comes from Object.keys(REGISTRY) / a for..in over the same object, so
// it is own by construction. Must pass.
const REGISTRY: Record<string, number> = { a: 1, b: 2 };

export function total(): number {
  let sum = 0;
  for (const key of Object.keys(REGISTRY)) sum += REGISTRY[key];
  for (const key in REGISTRY) sum += REGISTRY[key];
  return sum;
}
