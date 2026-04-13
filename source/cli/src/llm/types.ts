export interface LlmProvider {
  /** Send self-contained prompt, get verdict */
  verifyAspect(prompt: string): Promise<AspectResponse>;

  /** Check if provider is available (binary on PATH / endpoint reachable) */
  isAvailable(): Promise<boolean>;

  /** Query model context window size. Returns undefined if unknown. */
  getContextWindowSize(): Promise<number | undefined>;
}

export interface AspectResponse {
  satisfied: boolean;
  reason: string;
  /** True when the result is due to a provider error, not a code issue */
  providerError?: boolean;
}
