# Drift Types Responsibility

Types for drift detection, node approval, and audit trail.

**In scope:** DriftReport, DriftEntry, DriftStatus, DriftState, DriftNodeState, DriftCategory, TrackedFileLayer, DriftFileChange, AnnotatedChange, ApproveResult, AuditEntry, AspectVerificationResult, ArtifactReviewResult.

**Out of scope:** Graph model types (cli/model/graph), drift detection logic (cli/core/drift-detector), approval logic (cli/core/approve). No runtime behavior — types only.
