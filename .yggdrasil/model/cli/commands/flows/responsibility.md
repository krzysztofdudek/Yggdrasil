# Flows Command Responsibility

**In scope:** `yg flows`. Inventory of all business-process flows in the graph.

Shows each flow's participants and propagated aspects. This diagnostic helps agents understand which nodes participate in cross-cutting business processes before modifying code that could break process invariants.

**Out of scope:** Flow creation, modification, impact analysis (use `yg impact --flow`).
