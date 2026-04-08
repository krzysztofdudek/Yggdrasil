# Aspects Command Responsibility

**In scope:** `yg aspects`. Inventory of all aspects in the graph with per-aspect usage statistics.

Shows which aspects are actively used versus orphaned, and how each aspect reaches its nodes — distinguishing architecture-required, direct declaration, hierarchy inheritance, and flow propagation. This diagnostic helps maintain aspect hygiene: orphaned aspects are dead weight, and understanding propagation sources is essential before modifying or removing an aspect.

**Out of scope:** Aspect creation, modification, impact analysis (use `yg impact --aspect`).
