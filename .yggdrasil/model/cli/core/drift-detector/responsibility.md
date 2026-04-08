# Drift Detector Responsibility

Answers "has this node changed since last approve?" by comparing current file state against stored baselines. Read-only by design — drift detection never modifies state, which makes it safe to run at any time without side effects. Separation from approval is deliberate: detection reports the situation, approval decides what to do about it.
