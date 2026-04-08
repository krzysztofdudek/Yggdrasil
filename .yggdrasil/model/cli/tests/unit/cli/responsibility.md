# CLI Command Unit Tests — Responsibility

Guards the contract between Commander and core logic: argument validation, flag parsing edge cases, error message formatting, and exit code correctness. These failure modes are invisible in integration tests because integration tests exercise the happy path through real graph fixtures — they don't test what happens when arguments are missing, flags conflict, or loadGraph throws.
