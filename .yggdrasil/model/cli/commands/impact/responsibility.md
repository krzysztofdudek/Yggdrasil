# Impact Command Responsibility

**In scope:** `yg impact`. Answers "what breaks if I change this?" — the blast radius question agents must ask before modifying any node, aspect, or flow.

Without impact analysis, agents cannot know whether a change to one node silently breaks dependents, whether an aspect modification cascades to dozens of nodes, or whether a flow change affects participants they haven't considered. This command makes the invisible dependency web visible.

**Out of scope:** Modifying graph, resolving drift, validation.
