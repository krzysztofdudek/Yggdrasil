import { execFile } from 'node:child_process';
export function show(ref: string, file: string): void {
  execFile('git', ['show', `${ref}:${file}`]);
}
