import { CliAgentProvider } from './cli-base.js';

export class ClaudeCodeProvider extends CliAgentProvider {
  get binary() { return 'claude'; }
  get stdinMode() { return true; }

  buildArgs(_prompt: string): string[] {
    return ['--model', this.model, '--print'];
  }
}
