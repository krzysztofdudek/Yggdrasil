# Templates Responsibility

Agent rules content and platform-specific installation — the canonical text agents receive when operating in a Yggdrasil-managed repository. Hand-tuned by humans; never generated programmatically.

Rules content is structured into three cognitive sections (PROTOCOL, REFERENCE, GUARD RAILS) optimized for LLM attention patterns based on "Lost in the Middle" research. Default config and architecture templates provide minimal valid starting points for `yg init`. Graph schemas are copied to `.yggdrasil/schemas/` during init.

Platform installation handles per-IDE conventions (Cursor, Claude Code, Copilot, Cline, RooCode, Codex, Windsurf, Aider, Gemini, Amp, generic) so a single `yg init --platform` works everywhere.
