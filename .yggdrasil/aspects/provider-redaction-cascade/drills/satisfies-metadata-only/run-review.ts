// Orchestrates one reviewer call in the approval call chain.
import { debugWrite } from '../utils/debug-log.js';

interface Verdict {
  satisfied: boolean;
}

interface Provider {
  verifyAspect(prompt: string): Promise<Verdict>;
}

export async function runReview(provider: Provider, prompt: string, aspectId: string): Promise<Verdict> {
  debugWrite(`[review] dispatching ${aspectId}: ${prompt.length} chars`);
  return provider.verifyAspect(prompt);
}
