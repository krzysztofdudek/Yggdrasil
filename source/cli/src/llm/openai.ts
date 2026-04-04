import type { LlmProvider, ClaimResponse, ArtifactResponse } from './types.js';
import type { LlmConfig } from '../model/types.js';

export class OpenAIProvider implements LlmProvider {
  constructor(_config: LlmConfig) {}
  async isAvailable(): Promise<boolean> { return false; }
  async getContextWindowSize(): Promise<number | undefined> { return undefined; }
  async verifyClaim(): Promise<ClaimResponse> {
    throw new Error('OpenAI provider not yet implemented. Use ollama.');
  }
  async reviewArtifact(): Promise<ArtifactResponse> {
    throw new Error('OpenAI provider not yet implemented. Use ollama.');
  }
}
