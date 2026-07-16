import type { IMinimatch } from 'minimatch';
export function nameOf(m: IMinimatch): string {
  return m.pattern;
}
