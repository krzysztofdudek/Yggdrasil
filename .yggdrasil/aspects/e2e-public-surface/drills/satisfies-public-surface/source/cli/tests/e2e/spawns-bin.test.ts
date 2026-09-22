// DRILL — expected verdict: SATISFIED (No violations).
// The black-box pattern: drive the CLI only through its public surface by
// spawning the built binary. No relative import reaches into source/cli/src/.
import { spawnSync } from 'node:child_process';

export function runCli(binPath: string, args: string[]): string {
  const result = spawnSync('node', [binPath, ...args], { encoding: 'utf-8' });
  return result.stdout;
}
