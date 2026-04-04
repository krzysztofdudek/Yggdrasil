# LLM Provider — Interface

## Exports (from index.ts)

### `createLlmProvider(config: LlmConfig): LlmProvider`

Factory function that returns a concrete provider based on `config.provider`:
- `'ollama'` -> `OllamaProvider`
- `'openai'` -> `OpenAIProvider`
- `'anthropic'` -> `AnthropicProvider`
- Unknown value -> throws `Error`

### `LlmProvider` (interface)

```typescript
interface LlmProvider {
  verifyClaim(params: {
    aspectContent: string;
    claim: string;
    sourceCode: string;
    sourceFiles: string[];
  }): Promise<ClaimResponse>;

  reviewArtifact(params: {
    artifactContent: string;
    artifactName: string;
    sourceCode: string;
    sourceFiles: string[];
  }): Promise<ArtifactResponse>;

  isAvailable(): Promise<boolean>;
  getContextWindowSize(): Promise<number | undefined>;
}
```

### `ClaimResponse`

```typescript
interface ClaimResponse {
  satisfied: boolean;
  reason: string;
}
```

### `ArtifactResponse`

```typescript
interface ArtifactResponse {
  current: boolean;
  reason: string;
}
```

## Static Methods

### `OllamaProvider.resolveMaxTokens(config: LlmConfig, provider: LlmProvider): Promise<number>`

Resolves max token limit: uses `config.max_tokens` if set, otherwise queries `provider.getContextWindowSize()`, falling back to 4096.

## Provider Behavior

- **OllamaProvider**: Uses `POST /api/chat` with `format: 'json'` and `stream: false`. Retries once on failure. Strips markdown code fences from JSON responses before parsing. Returns a safe fallback response on parse failure.
- **OpenAIProvider**: Stub — `isAvailable()` returns false, operations throw.
- **AnthropicProvider**: Stub — `isAvailable()` returns false, operations throw.
