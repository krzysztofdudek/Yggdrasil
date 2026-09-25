# Provider Redaction Cascade

Nodes in the approval call chain — engines, CLI orchestrators, and shared helpers — must not capture, log, or persist raw LLM prompt or response data before redaction has been applied by the provider layer.

## Rules

- Code in this node must not write prompt content (aspect descriptions, source file text, combined reviewer prompts) to any log, file, console output, or diagnostic sink in its raw form. Logging structural metadata (node path, aspect id, token counts, elapsed time, exit code) is permitted.
- Code in this node must not write raw LLM response text to any sink before the LLM provider has applied its redaction. The redacted form (e.g. `[REDACTED]`) may be logged.
- If the node passes prompt or response data to another function, it must do so without locally caching or inspecting the content beyond what is needed for its immediate orchestration purpose.
- Exception: code that constructs the prompt for debugging purposes (e.g. `--dry-run` mode) may return the prompt to the CLI layer for output, but must not write it to persistent storage.
- Not covered: copying repository source into the repository's own drill corpus (`yg drill add` writing a past version of a file as a case). That writes the adopter's code back into the adopter's repository as a test fixture; it captures no reviewer prompt and no reviewer response. The rule still applies if such code writes a built prompt or a response.

## Rationale

An LLM approval workflow sends user source code and private aspect rules as prompt data. If any intermediate node in the call chain — an engine, a shared helper, or an orchestrator — logs this data before the provider applies redaction, the redaction mechanism in the provider is bypassed. The provider layer (covered by `provider-redaction`) handles the per-call redaction; this aspect ensures that the call chain leading to it does not short-circuit that protection.
