# Root Responsibility

Root-level project infrastructure — everything that defines how the repository works as a development environment but is not part of any specific feature module. CI/CD, editor conventions, container setup, licensing, and contribution guidelines.

This node exists because root-level files affect every contributor and every CI run but don't belong to any module. Changes here (especially to CI workflows or CLAUDE.md/AGENTS.md) have the highest implicit blast radius in the repo — they're invisible to `yg impact` because they're not in the graph's relation model.
