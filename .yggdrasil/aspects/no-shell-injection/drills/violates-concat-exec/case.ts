import { execSync } from 'child_process';
export function show(ref: string): string {
  return execSync('git show ' + ref).toString();
}
