# Quality Config — Responsibility

Centralizes quality governance thresholds for the entire graph. Without centralized thresholds, quality bounds would be magic numbers scattered across validators — unmaintainable and invisible to project owners. Having them in `yg-config.yaml` makes quality governance explicit and tunable per project.

Bounds matter because they protect against two failure modes: (1) artifact drift — artifacts too short to be useful silently degrade agent context quality, (2) context explosion — nodes with too many relations or too large context packages overwhelm agent context windows.
