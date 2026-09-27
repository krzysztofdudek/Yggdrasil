# pure-transforms — reproducible ETL transforms (script rule over Python)

**Scenario:** an analytics/ETL data pipeline written in **Python**. The functions
in the `transforms` package must be *reproducible* — replaying the pipeline over
the same source data must always yield the same result.

**Capability demonstrated:** a **script rule** (`deterministic-transforms`)
that ships a `check.mjs` and runs a robust line scan over the node's `.py` files.
It refuses any line in `src/transforms/*.py` that reads the wall clock
(`datetime.now(`, `datetime.utcnow(`, `time.time(`) or draws randomness
(`random.*`). Reading the clock makes a run depend on *when* it ran; randomness
makes it depend on a seed — either one breaks replayability and back-fills.

This runs at **zero reviewer cost and needs no API key**. It also shows that
Yggdrasil's checks work across many languages, not just TypeScript — the same
`check(ctx)` contract here drives a plain text scan of Python source.

## Layout

```
src/
  pipeline.py            orchestrator — ALLOWED to time a run and log (not a transform)
  transforms/
    clean.py             pure cleaning transforms (deterministic)
    aggregate.py         pure aggregation transforms (deterministic)
.yggdrasil/
  yg-architecture.yaml   one node type: pipeline (maps src/**)
  yg-config.yaml         keyless — script rules only, no reviewer is ever contacted
  model/pipeline/        the node mapping all src/**/*.py
  aspects/deterministic-transforms/
    yg-aspect.yaml       script rule (reviewer.type: deterministic)
    check.mjs            the line scan (scoped to transforms/*.py only)
```

The reproducibility rule is deliberately scoped to the `transforms` package.
`pipeline.py` stamps its output with a run timestamp and times the run — an
orchestration concern, not a transformation — so it is not subject to the rule.

## Reproduce GREEN from a clean clone

Run everything with this directory as the working directory. `yg` is the built
CLI at `source/cli/dist/bin.js`.

```bash
cd examples/pure-transforms

# 1) Free, keyless fill of the script verdict cache (no reviewer, no key).
#    On a fresh clone the script pair is UNVERIFIED until this runs.
node ../../source/cli/dist/bin.js check --approve --only-deterministic

# 2) Plain check re-hashes the cached verdict and runs the built-in checks live.
node ../../source/cli/dist/bin.js check
```

Expected final output (exit 0):

```
yg check: PASS  1 node · 3/3 files covered · 5 excluded · 1 pair verified (script)
```

> The script verdict is cached in the **gitignored**
> `.yggdrasil/.yg-lock.deterministic.json`. It is rebuilt for free by the
> `--approve --only-deterministic` step above and is never committed.

## The ONE edit that BREAKS the rule

Add a wall-clock read inside a transform. In `src/transforms/clean.py`, at the
top add `import datetime`, and inside `strip_whitespace` add a line such as:

```python
out["_cleaned_at"] = datetime.datetime.now().isoformat()
```

Then re-fill the cache (the source changed, so the verdict is invalidated) and
check:

```bash
node ../../source/cli/dist/bin.js check --approve --only-deterministic
node ../../source/cli/dist/bin.js check
```

You will see the refusal (exit 1), pointing at the exact line you added (the
line number depends on where you inserted the import) — for example:

```
yg check: FAIL  1 error   1 node · 3/3 files covered · 5 excluded

error[refused] deterministic-transforms — 1 violation in pipeline
  at:   pipeline  src/transforms/clean.py:20  Transforms must be reproducible: line references datetime.now(). Reading the wall clock or drawing randomness makes the pipeline unreplayable. Pass any needed timestamp or seed in as an argument, or move this concern to the orchestrator (pipeline.py).
  why:  Functions in the transforms package must be reproducible: no wall-clock reads and no randomness.
  fix:  Change the code at these lines, then run yg check --approve --only-deterministic (free) to record the new verdict.

next: edit src/transforms/clean.py:20
```

Remove the two added lines to restore green (re-run the two commands above).
