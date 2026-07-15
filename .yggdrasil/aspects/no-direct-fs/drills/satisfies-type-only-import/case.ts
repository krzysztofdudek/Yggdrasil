import type { Stats } from 'node:fs';
export function sizeOf(s: Stats): number {
  return s.size;
}
