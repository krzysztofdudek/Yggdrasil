# Model-Swap Protocol

Reviewer tiers name a model. Sooner or later you will want to point a tier at a
newer or cheaper model. This page is the safe way to do it — because a model swap
is **silent by design**, and silence is exactly where trust leaks.

## Why a model swap is silent

A verdict is content-addressed: it stays valid only while the inputs that produced
it are unchanged. The reviewer tier is one of those inputs — but only the tier's
**name** is. The model, provider, and connection details behind the tier are
deliberately **not** part of a verdict's identity.

That is a feature: it lets you fix a typo in a tier's endpoint, rotate a key, or
retune a provider without invalidating thousands of green verdicts. But it has a
sharp consequence:

> Re-pointing a tier from one model to another does **not** invalidate a single
> cached verdict. Every pair that was green stays green — now attributed to a model
> that never actually reviewed it.

Nothing in the normal check flow will tell you the new model would have judged any
of that code differently. The swap leaves no trace in the lock. So before you flip
the switch, you have to generate the before/after signal yourself.

## The only honest before/after: a paired comparison

You cannot compare the two models by re-running a full check — the cache would
serve the old verdicts unchanged. You have to run the **same cases** through
**both** models and compare them head to head. That is what a regression drill
corpus is for, and what a paired statistical test measures.

Two reviewers judging the same set of cases produce four outcomes per case:

| | new model accepts | new model rejects |
|---|---|---|
| **old model accepts** | agree (accept) | disagree — new is stricter |
| **old model rejects** | disagree — new is more lenient | agree (reject) |

The cases where they **agree** carry no information about a difference between the
models — only the two **disagreement** cells do. McNemar's test looks at exactly
those two cells and asks whether the imbalance between them is real or noise. It is
the correct test for paired yes/no outcomes, and it is honest about small samples
(it uses an exact calculation when the disagreement count is low).

## The procedure

1. **Add the candidate as a new, separate tier** in your reviewer config — do
   **not** re-point the existing one yet. You want both models available under two
   distinct tier names (for example, your current `standard` and a new
   `standard-candidate`) so their results can be told apart.

2. **Dry-fit on a few nodes first** (optional but cheap):

   ```
   yg aspect-test --aspect <id> --node <path> --tier standard-candidate
   ```

   This runs the candidate against real nodes without touching the lock or the
   graph — a quick sniff test before you spend on the full corpus.

3. **Run your regression drill corpus under both tiers**, so every case is recorded
   once under the current model and once under the candidate:

   ```
   yg drill            # under the current tier
   # then re-point the corpus at the candidate tier and:
   yg drill            # under the candidate tier
   ```

   Each drill case is logged locally with the tier it ran under. This is local,
   private telemetry — it is never committed and never affects a verdict.

4. **Run the paired comparison.** This repository ships a reference implementation
   of the McNemar analysis over the local drill telemetry:

   ```
   node scripts/mcnemar.mjs --old standard --new standard-candidate
   ```

   It pairs every case run under both tiers, builds the disagreement table, and
   reports — in plain words — how many violations the old model caught that the new
   one missed, how many the reverse, and whether that difference is statistically
   meaningful on your corpus.

5. **Read the result as a decision, not a verdict.**
   - **No significant difference** → the swap is safe on the evidence you have; the
     two models are interchangeable on this corpus.
   - **New model more lenient** (it accepts cases the old one rejected) → the swap
     would quietly *weaken* enforcement. Treat this as a regression.
   - **New model stricter** (it rejects cases the old one accepted) → the swap would
     *tighten* enforcement; expect new rejections on your next real change even where
     the code did not move.

6. **Flip the tier — then decide about the existing green verdicts.** Once you
   re-point the live tier, remember that every existing green pair keeps its old
   verdict. If the comparison showed the models differ, those cached greens are now
   stale opinions from the previous model. Re-verify them deliberately if it
   matters — a model swap will **not** re-verify them for you.

## What the comparison cannot tell you

- **Small samples are indicative, not decisive.** A handful of disagreements on a
  thin corpus is a hint, not a proof. Grow the corpus before betting on the result.
- **An absent case is not an agreement.** Cases that only ran under one tier, or
  that could not run at all, are excluded from the pairing — never silently counted
  as the two models agreeing.
- **It measures the corpus, not the world.** The test tells you how the two models
  compare on the cases you gave it. It says nothing about code neither model has
  seen.

The discipline is simple: a model swap changes who is judging your code without
telling anyone. The paired comparison is how you make that change visible before it
becomes a silent regression.
