import { count, paint, writeOut, writeErr } from './output.js';

export function report(n: number, refusedWord: string): void {
  writeOut(`${count(n, 'pair')} verified\n`);
  writeErr(`${paint.red(refusedWord)}\n`);
}
