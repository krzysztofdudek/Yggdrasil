# Utils Unit Tests — Responsibility

Guards determinism of path normalization, hashing, and token estimation — the primitives that drift detection and context budget depend on. A hash function that produces different results for the same input breaks every approval baseline. A path normalizer that mishandles separators breaks every file mapping on Windows. Debug log tests guard that diagnostic capture doesn't interfere with normal stdout/stderr output.
