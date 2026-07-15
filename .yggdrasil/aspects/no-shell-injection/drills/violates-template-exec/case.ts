import { exec } from 'node:child_process';
export function run(dir: string): void {
  exec(`ls ${dir}`);
}
