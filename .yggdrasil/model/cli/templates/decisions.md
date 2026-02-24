# Templates Decisions

**Hand-tuned content:** Agent rules content is explicitly maintained by humans. The rules.ts comment states: "Canonical agent rules content — hand-tuned, do not generate programmatically." This ensures the operating manual reflects deliberate design decisions.

**Intent capture mandate:** The rules enforce "CAPTURE INTENT, BUT NEVER INVENT IT" — agents must permanently record the user's "why" (business reason, rationale) in graph artifacts when provided, but never infer or hallucinate it. This makes the graph the semantic meaning layer (Intent → Graph → Outputs) and protects against chat context evaporation.

**Platform-specific installation:** Each agent platform has its own conventions for rules location. The platform.ts module centralizes this mapping so `yg init --platform <name>` works consistently across IDEs.

**Default config as template:** DEFAULT_CONFIG provides a minimal valid config.yaml that adopters can customize. It mirrors config.yaml schema but is a string constant for embedding.
