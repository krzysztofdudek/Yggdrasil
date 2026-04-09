# Utils — Responsibility

Stateless, domain-free primitives shared across CLI modules. If a helper starts encoding business rules, it belongs in an engine module instead.

Exception: debug-log maintains module-level state (logPath, hooked stdout/stderr) by design — it must persist across the CLI invocation lifetime to capture all output. This is essential state, not accidental. `initDebugLog` is idempotent to prevent double-hooking.
