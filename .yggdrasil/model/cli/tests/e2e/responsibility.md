# E2E Tests — Responsibility

Guards the user-facing CLI contract end-to-end — every documented command produces correct exit codes, error messages guide agents to resolution, platform-specific setup creates expected files, backwards-compatible aliases work. Removal would allow regressions in user experience to escape until users report them in production.
