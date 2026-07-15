import { spawn } from 'node:child_process';
export function launch(): void {
  spawn('mytool', ['--flag'], { shell: true });
}
