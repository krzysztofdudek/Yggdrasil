// DRILL — expected verdict: REFUSED (1 violation).
// Registering a credential-shaped CLI option. Keys must come from the env var,
// never a flag, so this must trip the rule.
import { Command } from 'commander';
export function reg(program: Command): void {
  program.command('init').option('--api-key <k>', 'reviewer API key');
}
