// LLM provider implementation for the Acme HTTP API.
import { apiFetch } from '../llm/api-utils.js';

interface AspectResponse {
  satisfied: boolean;
  reason: string;
  providerError?: boolean;
}

export class AcmeProvider {
  constructor(
    private readonly url: string,
    private readonly configured: boolean,
  ) {}

  async verifyAspect(prompt: string): Promise<AspectResponse> {
    try {
      const res = await apiFetch(this.url, { method: 'POST', body: prompt });
      return (await res.json()) as AspectResponse;
    } catch (error) {
      return {
        satisfied: false,
        reason: `acme provider error: ${(error as Error).message}`,
        providerError: true,
      };
    }
  }

  isAvailable(): boolean {
    return this.configured;
  }
}
