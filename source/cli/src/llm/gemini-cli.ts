import { CliAgentProvider } from './cli-base.js';
import { registerProvider } from './provider.js';

export class GeminiCliProvider extends CliAgentProvider {
  get binary() { return 'gemini'; }
  get stdinMode() { return false; }
  buildArgs(prompt: string) { return ['-p', prompt, '-o', 'json', '-m', this.model]; }
}

registerProvider('gemini-cli', (c) => new GeminiCliProvider({ model: c.model, timeout: c.timeout }));
