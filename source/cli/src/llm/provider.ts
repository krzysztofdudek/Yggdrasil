import type { LlmConfig } from '../model/graph.js';
import type { LlmProvider } from './types.js';

type ProviderFactory = (config: LlmConfig) => LlmProvider;

const registry = new Map<string, ProviderFactory>();

export function registerProvider(name: string, factory: ProviderFactory): void {
  registry.set(name, factory);
}

export function createLlmProvider(config: LlmConfig): LlmProvider {
  const factory = registry.get(config.provider);
  if (!factory) throw new Error(`Unknown reviewer provider: ${config.provider}`);
  return factory(config);
}
