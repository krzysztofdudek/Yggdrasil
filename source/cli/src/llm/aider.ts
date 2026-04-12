import { CliAgentProvider } from './cli-base.js';
import { registerProvider } from './provider.js';

export class AiderProvider extends CliAgentProvider {
  get binary() { return 'aider'; }
  get stdinMode() { return false; }
  buildArgs(prompt: string) {
    return ['--message', prompt, '--chat-mode', 'ask', '--yes', '--no-stream', '--no-pretty', '--model', this.model];
  }
}

registerProvider('aider', (c) => new AiderProvider({ model: c.model, timeout: c.timeout }));
