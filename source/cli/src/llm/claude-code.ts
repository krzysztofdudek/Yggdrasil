import { CliAgentProvider } from './cli-base.js';
import { registerProvider } from './provider.js';

// Strip all caller-side context that would otherwise pollute the reviewer prompt.
// Each flag removes one class of injected state:
//   --tools ""                            no built-in tools
//   --disable-slash-commands              no skills loaded into system prompt
//   --setting-sources ""                  no user/project/local settings.json (skips hooks too)
//   --strict-mcp-config + empty servers   ignore MCP servers from host config
//   --no-session-persistence              no session written to disk
//   --exclude-dynamic-system-prompt-sections  drop cwd/env/git-status injection
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
    return ['--model', this.model, '--print', ...ISOLATION_ARGS];
  }
}

registerProvider('claude-code', (config) => new ClaudeCodeProvider({ model: config.model, timeout: config.timeout }));
