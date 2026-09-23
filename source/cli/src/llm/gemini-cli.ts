import { CliAgentProvider } from './cli-base.js';
import { registerProvider } from './provider.js';

export class GeminiCliProvider extends CliAgentProvider {
  get binary() { return 'gemini'; }
  // The prompt goes on stdin (the CLI runs non-interactively on piped input): a large component's
  // prompt is past what one argument may carry on Linux (128 KiB) and past a whole Windows command
  // line (32,767 characters).
  get stdinMode() { return true; }
  protected get installHint() { return 'install the Gemini CLI (npm i -g @google/gemini-cli) and sign in by running `gemini` once'; }
  buildArgs(_prompt: string) { return ['-o', 'json', '-m', this.model]; }
}

registerProvider('gemini-cli', (c) => new GeminiCliProvider({ model: c.model, timeout: c.timeout }));
