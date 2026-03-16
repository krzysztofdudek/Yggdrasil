```markdown
# estimateTokens Function Documentation

## Purpose
The `estimateTokens` function provides a heuristic-based estimate of the token count for a given string. It is designed to approximate tokenization without relying on a specific tokenizer, making it lightweight and versatile.

## Usage
This function is useful in scenarios where a quick, approximate token count is needed, such as in text processing pipelines, cost estimation for token-based APIs, or preprocessing steps where exact tokenization is not critical.

## Behavior
- **Input**: Accepts a string (`text`) as input.
- **Output**: Returns an integer representing the estimated number of tokens.
- **Heuristic**: Assumes approximately 4 characters per token, which is a common rule of thumb for many tokenization schemes.
- **Rounding**: Uses `Math.ceil` to round up the result, ensuring the estimate does not underestimate the token count.

## Example
```typescript
const text = "Hello, world!";
const estimatedTokens = estimateTokens(text); // Returns 4
```

## Limitations
- The estimate is based on a fixed character-to-token ratio and may not accurately reflect token counts for all languages or tokenization methods.
- Does not account for special cases like punctuation, whitespace, or multi-token words.

## Signature
```typescript
export function estimateTokens(text: string): number
```
```