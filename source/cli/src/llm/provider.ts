import type { LlmConfig } from '../model/types.js';
import type { LlmProvider } from './types.js';
import { OllamaProvider } from './ollama.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';

export function createLlmProvider(config: LlmConfig): LlmProvider {
  switch (config.provider) {
    case 'ollama': return new OllamaProvider(config);
    case 'openai': return new OpenAIProvider(config);
    case 'anthropic': return new AnthropicProvider(config);
    default: throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}
