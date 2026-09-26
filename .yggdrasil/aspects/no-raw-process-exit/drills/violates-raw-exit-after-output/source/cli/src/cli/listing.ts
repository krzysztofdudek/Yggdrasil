import { writeOut } from './output.js';

export function list(lines: string[]): void {
  writeOut(lines.join('\n'));
  process.exit(0);
}
