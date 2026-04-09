# Context Builder Responsibility

The bridge between the static graph on disk and the dynamic context agents consume. Without context assembly, agents would need to manually traverse hierarchy, resolve aspect implies chains, and aggregate dependency interfaces — error-prone work that should happen once, deterministically.

Context assembly is deterministic: layers are composed in a fixed order — global, hierarchy (ancestors from root to parent), own, relational (dependencies), flows, aspects — and that order is an invariant. Any caller receiving context from the same graph state gets the same result.

Also provides the tracked file list for drift detection — mirrors the assembly traversal but returns paths instead of content, enabling drift-detector to know which files to monitor for which node.
