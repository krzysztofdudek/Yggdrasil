import type { LlmConfig } from '../model/graph.js';
import type { LlmProvider } from './types.js';
import { OllamaProvider } from './ollama.js';
import { ClaudeCodeProvider } from './claude-code.js';

export function createLlmProvider(config: LlmConfig): LlmProvider {
  switch (config.provider) {
    case 'ollama': return new OllamaProvider(config);
    case 'claude-code': return new ClaudeCodeProvider({ model: config.model });
    default: throw new Error(`Unknown reviewer provider: ${config.provider}`);
  }
}
