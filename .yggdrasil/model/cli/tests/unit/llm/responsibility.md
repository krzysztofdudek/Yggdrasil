# LLM Unit Tests — Responsibility

Guards graceful degradation when LLM backends are unavailable or return malformed responses. Without these tests, a provider API change or network failure could crash the CLI instead of falling back safely — turning every approve into a hard failure instead of a degraded-but-functional pass.
