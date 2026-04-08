# CLI Command Unit Tests — Responsibility

Guards the output formatting contract and batch operation correctness. CLI output structure (aspect results, artifact reviews, cascade grouping, node separators) is the primary interface agents parse — regressions here silently break every agent's ability to interpret yg output. Batch approve logic (cascade filtering, concurrency ordering, --reviewed acceptance) is the parallel execution contract — correctness failures here produce wrong approval decisions at scale.
