# Flows Command Interface

**Command:** `yg flows` — no arguments, no options.

**Output structure per flow:**

```
<name> — <description>             # description line omitted when flow has no description
  Participants: <count> nodes (<sorted comma-separated paths>)
  Aspects: <comma-separated aspect ids>    # only when flow has aspects
```

Flows sorted alphabetically by name.

## Failure Modes

- No .yggdrasil/ directory: exit 1.
- Generic I/O errors: stderr, exit 1.
