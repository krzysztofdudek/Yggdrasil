import { CliAgentProvider } from './cli-base.js';
import { registerProvider } from './provider.js';

export class OpenCodeProvider extends CliAgentProvider {
  get binary() { return 'opencode'; }
  get stdinMode() { return false; }
  buildArgs(prompt: string) { return ['run', '--format', 'json', '-m', this.model, prompt]; }
}

registerProvider('opencode', (c) => new OpenCodeProvider({ model: c.model, timeout: c.timeout }));
