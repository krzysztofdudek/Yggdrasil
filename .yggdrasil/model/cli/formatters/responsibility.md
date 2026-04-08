# Formatters Responsibility

Output formatting for CLI commands — transforms structured context data into human-readable text. Pure functions with no I/O, no validation, no graph modification. Callers own input validity.

Covers YAML context output (`formatContextYaml`), node context text (`formatNodeContext` with blast radius vocabulary), file context text (`formatFileContext` with candidate nodes for unmapped files), full content mode (`formatFullContent` with XML-style tags), and structured diagnostic messages (`buildIssueMessage` enforcing what/why/next structure).
