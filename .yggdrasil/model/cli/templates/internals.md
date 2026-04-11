# Templates Internals

## Decisions

Chose hand-tuned content over programmatic generation. The rules are an operating manual for LLM agents — tone, structure, and emphasis require human judgment.

Chose three-section structure (PROTOCOL, REFERENCE, GUARD RAILS) based on "Lost in the Middle" research (Liu et al., Stanford, TACL 2024): procedures at edges (primacy/recency zones where agents internalize steps), reference material in middle (lookup-only material tolerates lower attention).

Chose motivation-first opening ("the graph exists so the user does not have to explain the same thing twice") over authority-based framing ("YOU DO NOT HAVE A CHOICE"). Agents under task pressure drop procedural rules but retain motivational framing.

Chose to remove the read-only preflight exception ("skip preflight for explain/analyze requests") because agents classified code analysis as "read-only" and skipped graph context. The exception is unfixable — agents cannot know if content is mapped without running yg.

Chose per-platform installation over a single rules file format because each IDE has its own conventions for rules location and format (frontmatter, section markers, import syntax).

Chose `yg select` as the task-level graph trigger because it's goal-oriented (fires before the agent knows which files to read) and already exists in the CLI. The file-level trigger (`yg context --file`) remains — both apply independently.
