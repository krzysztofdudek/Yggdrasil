import { CliAgentProvider } from './cli-base.js';
import { registerProvider } from './provider.js';

export class ClineProvider extends CliAgentProvider {
  get binary() { return 'cline'; }
  get stdinMode() { return false; }
  buildArgs(prompt: string) { return ['-y', '--json', '-m', this.model, prompt]; }
}

registerProvider('cline', (c) => new ClineProvider({ model: c.model, timeout: c.timeout }));
