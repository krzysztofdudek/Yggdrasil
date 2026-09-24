import { count, plural } from '../utils/count.js';

export function what(n: number, types: string[]): string {
  return `${count(n, 'node')} need a log entry; allowed relation ${plural(types.length, 'type')}: ${types.join(', ')}`;
}
