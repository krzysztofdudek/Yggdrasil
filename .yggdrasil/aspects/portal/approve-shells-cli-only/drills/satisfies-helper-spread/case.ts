import { spawn } from 'node:child_process';
const BIN = '/path/to/bin.js';
function approveArgs(llm: boolean): string[] {
  return llm ? ['check', '--approve'] : ['check', '--approve', '--only-deterministic'];
}
export function spawnCli(args: string[]): void {
  spawn(process.execPath, [BIN, ...args], { cwd: '.' });
}
export function run(): void {
  spawnCli(approveArgs(true));
}
