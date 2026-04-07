# Internals

## Logic

Three-axis change detection (own artifacts, source files, upstream context) determines the approve action. When all three axes are clean, no-change. When both own and source changed, approved. When only one side changed, refused unless `--reviewed` bypasses the three-axis gate.

After three-axis resolution, the reviewer (LLM provider) runs aspect verification (E055) and optionally artifact review (E056). Reviewer refusal overrides any prior approval or review action.

## Decisions

Chose to split three-axis gate from reviewer gate. `--reviewed` bypasses structural check only. Rejected: single `--acknowledge` that bypasses both gates — agents used it to rubber-stamp aspect failures (the "deterministic" incident where an agent used --acknowledge to bypass E055 instead of fixing the graph).
