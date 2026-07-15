import { exec } from 'node:child_process';
export function status(): void {
  exec('git status --porcelain');
}
