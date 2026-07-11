// LLM provider implementation for the Acme HTTP API.
interface AspectResponse {
  satisfied: boolean;
  reason: string;
}

export class AcmeProvider {
  constructor(private readonly url: string) {}

  async verifyAspect(prompt: string): Promise<AspectResponse> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(this.url, { method: 'POST', body: prompt });
      if (res.ok) {
        return (await res.json()) as AspectResponse;
      }
    }
    throw new Error('acme provider: all retries failed');
  }
}
