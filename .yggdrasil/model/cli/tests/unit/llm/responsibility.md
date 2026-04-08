# LLM Unit Tests — Responsibility

Unit tests for the LLM provider abstraction — verifies provider factory selection, connection failure handling, response parsing, and fallback behavior. Exists because LLM interactions involve external services with unpredictable failure modes that must be exercised through mocked HTTP and subprocess boundaries.

Covers both provider implementations (Claude Code subprocess, Ollama HTTP) without requiring live LLM access.
