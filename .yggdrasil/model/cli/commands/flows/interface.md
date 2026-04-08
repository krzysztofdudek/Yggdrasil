# Flows Command Interface

**Command:** `yg flows` — no arguments, no options.

**Output structure per flow:**

```
<name> — <description>
  Participants: <count> nodes (<sorted comma-separated paths>)
  Aspects: <comma-separated aspect ids>    # only when flow has aspects
```

Flows sorted alphabetically by name.

**Contract:** Flow-level aspects propagate to all participants — every participant must satisfy them. This is the enforcement mechanism for cross-cutting business process requirements.

## Failure Modes

- No .yggdrasil/ directory: exit 1.
- Generic I/O errors: stderr, exit 1.
