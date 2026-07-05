// DRILL — expected verdict: SATISFIED (No violations).
// The sanctioned pattern: the key comes from the provider env var, and no
// credential-shaped option is registered. Near-miss options (--model, --provider)
// must NOT trip the rule.
import { Command } from 'commander';
const API_KEY_ENV: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY' };
export function reg(program: Command): void {
  program.command('init').option('--model <name>', 'reviewer model').option('--provider <name>', 'reviewer provider');
}
export function readKey(provider: string): string | undefined {
  const envVar = API_KEY_ENV[provider];
  return envVar ? process.env[envVar]?.trim() : undefined;
}
