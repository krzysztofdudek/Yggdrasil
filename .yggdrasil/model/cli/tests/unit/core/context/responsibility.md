# Context Core Unit Tests — Responsibility

Guards the context assembly contract: correct layer merging, budget computation, and structured output generation. Context packages are the primary interface between the CLI and agents — incorrect assembly means agents receive wrong constraints, leading to code that violates aspects or misses dependencies. Uses in-memory graph fixtures to cover edge cases that real graph fixtures cannot reliably reproduce.
