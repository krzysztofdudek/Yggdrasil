# Drift Types Responsibility

Types for the trust lifecycle: drift detection → approval → audit. These types form a cohesive domain because they all describe states of the "is this node's graph consistent with its source?" question. DriftNodeState persists the baseline, DriftEntry reports current status, ApproveResult captures the approval decision, and AuditEntry records the history.

Separated from graph types because drift state is ephemeral and per-node (changes every approve), while graph types are structural and stable. AspectVerificationResult and ArtifactReviewResult live here (not in LLM types) because they're cached in drift state — they're verification results, not provider contracts.
