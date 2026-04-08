# Validator Internals

## Decisions

Chose stable error codes (E001-E058, W001-W017) as machine-readable identifiers. CI pipelines and automation match on codes rather than fragile message text. New rules receive the next available code.

Chose to separate informational budget warnings (W005/W006 with per-category breakdown) from actionable own-budget warning (W015). Agents need different responses: W005/W006 require diagnosis (maybe dependencies are the problem), while W015 requires action (split the node). The previous single W005 approach was interpreted by agents as permission to delete artifact content.

Chose to consolidate E003, E035 into E050 (dangling-aspect-ref) — one code for "aspect doesn't exist" regardless of where it's referenced (node, flow, architecture type, port).

Chose to remove E037/E040/E041 (regex proof system) and move semantic verification to approve-time LLM (E055/E056). Deterministic regex matching was too brittle for aspect compliance checking.

Chose to tolerate cycles involving blackbox nodes in E008 — blackbox nodes are opaque and breaking on their cycles would prevent validating the rest of the graph.

Chose to rewrite E053 for per-consumed-port validation: if node A consumes port X of node B and port X requires aspect Y, Y must exist. Structural only — semantic verification happens at approve via E055.
