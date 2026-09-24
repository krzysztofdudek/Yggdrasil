import { CliAgentProvider } from './cli-base.js';
import { registerProvider } from './provider.js';
import type { ReviewerUsage } from './types.js';

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Unwrap `claude --print --output-format json`: one JSON object whose `result`
 * is the model's reply text, with `usage` (tokens) and `total_cost_usd` beside
 * it. Anything that is not that envelope — an older CLI, a stub — is handed
 * back as raw text for the verdict parser, which is what ran before.
 */
export function unwrapClaudeJson(stdout: string): { reply: string; usage?: ReviewerUsage; error?: string } {
  let env: unknown;
  try {
    env = JSON.parse(stdout.trim());
  } catch {
    return { reply: stdout };
  }
  if (typeof env !== 'object' || env === null || Array.isArray(env)) return { reply: stdout };
  const e = env as Record<string, unknown>;
  if (e.type !== 'result' || typeof e.result !== 'string') return { reply: stdout };
  const u = (typeof e.usage === 'object' && e.usage !== null ? e.usage : {}) as Record<string, unknown>;
  const input = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens]
    .map(finite).filter((n): n is number => n !== undefined);
  const usage: ReviewerUsage = {};
  if (input.length > 0) usage.inputTokens = input.reduce((a, b) => a + b, 0);
  const out = finite(u.output_tokens);
  if (out !== undefined) usage.outputTokens = out;
  const cost = finite(e.total_cost_usd);
  if (cost !== undefined) usage.costUsd = cost;
  const withUsage = Object.keys(usage).length > 0 ? { usage } : {};
  if (e.is_error === true) return { reply: e.result, error: e.result || 'is_error with no message', ...withUsage };
  return { reply: e.result, ...withUsage };
}

// Strip all caller-side context that would otherwise pollute the reviewer prompt.
// Each flag removes one class of injected state:
//   --tools ""                            no built-in tools
//   --disable-slash-commands              no skills loaded into system prompt
//   --setting-sources ""                  no user/project/local settings.json (skips hooks too)
//   --strict-mcp-config + empty servers   ignore MCP servers from host config
//   --no-session-persistence              no session written to disk
//   --exclude-dynamic-system-prompt-sections  drop cwd/env/git-status injection
// And `--output-format json` so the reply arrives with its token usage and
// cost (see unwrapClaudeJson) — the figures behind the end-of-fill summary.
const ISOLATION_ARGS: string[] = [
  '--tools', '',
  '--disable-slash-commands',
  '--setting-sources', '',
  '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}',
  '--no-session-persistence',
  '--exclude-dynamic-system-prompt-sections',
];

export class ClaudeCodeProvider extends CliAgentProvider {
  get binary() { return 'claude'; }
  get stdinMode() { return true; }
  protected get installHint() { return 'install Claude Code (npm i -g @anthropic-ai/claude-code) and sign in with `claude`'; }

  buildArgs(_prompt: string): string[] {
    return ['--model', this.model, '--print', '--output-format', 'json', ...ISOLATION_ARGS];
  }

  protected extractReply(stdout: string): { reply: string; usage?: ReviewerUsage; error?: string } {
    return unwrapClaudeJson(stdout);
  }
}

registerProvider('claude-code', (config) => new ClaudeCodeProvider({ model: config.model, timeout: config.timeout }));
