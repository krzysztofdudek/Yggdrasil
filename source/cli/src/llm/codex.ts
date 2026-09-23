import { CliAgentProvider } from './cli-base.js';
import { registerProvider } from './provider.js';

export class CodexProvider extends CliAgentProvider {
  get binary() { return 'codex'; }
  get stdinMode() { return true; }
  protected get installHint() { return 'install the Codex CLI (npm i -g @openai/codex) and sign in with `codex login`'; }
  buildArgs(_prompt: string) {
    return ['exec', '-', '--json', '-m', this.model,
      '--output-schema', JSON.stringify({
        type: 'object',
        properties: { satisfied: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['satisfied', 'reason'],
      })];
  }
}

registerProvider('codex', (c) => new CodexProvider({ model: c.model, timeout: c.timeout }));
