// A computed WRITE (or delete) is a different concern — the prototype-inheritance
// hazard is about reading an inherited value, not assigning an own one. Must pass.
const REGISTRY: Record<string, number> = { a: 0 };

export function set(key: string, value: number): void {
  REGISTRY[key] = value;
}

export function bump(key: string): void {
  REGISTRY[key] += 1;
}

export function drop(key: string): void {
  delete REGISTRY[key];
}
