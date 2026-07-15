import { spawn } from 'node:child_process';
function approveArgs(): string[] {
  return ['check', '--approve'];
}
export function spawnCli(args: string[]): void {
  spawn(process.env.YG_BIN as string, [...args], { cwd: '.' });
}
export function run(): void {
  spawnCli(approveArgs());
}
