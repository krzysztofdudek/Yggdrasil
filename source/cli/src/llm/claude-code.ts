import { CliAgentProvider } from './cli-base.js';
import { registerProvider } from './provider.js';

export class ClaudeCodeProvider extends CliAgentProvider {
  get binary() { return 'claude'; }
  get stdinMode() { return true; }

  buildArgs(_prompt: string): string[] {
    return ['--model', this.model, '--print'];
  }
}

registerProvider('claude-code', (config) => new ClaudeCodeProvider({ model: config.model, timeout: config.timeout }));
