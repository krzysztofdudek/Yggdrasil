# Exp 3.1b Scoring: Completeness Audit for Omission Detection

## Target Omission

The C2 graph variant has the "## Timing" section surgically removed from
`aspects/pubsub-events/content.md`. The original section documented:

> Events are published AFTER the database transaction commits successfully. This prevents
> phantom events where the client sees an update but the transaction rolled back. The
> exception is `deleteCollectionAndUpdateSiblingsOrderIndex` where the PubSub call happens
> after the retry loop succeeds.

## Did the Agent Detect the Missing Timing Invariant?

### Verdict: NOT DETECTED

The agent produced 16 omission findings across the entire graph, many of them genuine and
valuable. However, **none of them explicitly identify that the pubsub-events aspect is
missing timing information** — the core invariant about WHEN events fire relative to
transaction commit.

### What the Agent Found Instead

The closest findings to the planted omission:

| Finding | Relationship to planted omission |
|---------|--------------------------------|
| #7: moveCollection lock acquisition ORDER | Concurrency ordering, not PubSub timing |
| #8: updateCollectionOrder publishes stale data | Data staleness, not commit timing |
| Aspect exception: updateCollectionOrder publishes PRE-TRANSACTION stale data | Related but about data, not about the timing rule |
| #6: import publishes only for top-level | Scope omission, not timing |

The agent identified multiple PubSub-RELATED gaps in specific methods but did NOT step back
and ask: "Does the pubsub-events aspect document all of its important properties? Is there
a timing/ordering specification?"

### Comparison with Original Exp 9 C2

| Dimension | Original C2 (consistency prompt) | New C2 (completeness prompt) |
|-----------|----------------------------------|------------------------------|
| Timing invariant detected? | NO | NO |
| Other omissions found | 14 | 16 |
| Quality of other findings | Mixed | Higher quality, better severity ordering |
| PubSub timing mentioned at all? | No | Indirectly (stale data, aspect exceptions) |
| False positives | 0 | 0 |

### Why the Completeness Prompt Failed on This Omission

The completeness prompt asked:
1. For each public method: is it documented? → Agent excelled here
2. For each error path: is it captured? → Agent found several gaps
3. For each behavioral invariant: is it captured? → Agent found method-level invariants
4. For each cross-cutting pattern: are all relevant constraints documented? → **PARTIAL**

The agent interpreted instruction #4 as "does each METHOD correctly follow the aspect?"
(violation detection), not "does each ASPECT document all its properties?" (aspect
completeness). The agent checked whether code conforms to aspects but did not check whether
aspects are themselves complete.

### The Root Cause

**The agent's mental model of completeness is method-centric, not artifact-centric.**

It asked: "For each method in the code, is it in the graph?" — and found many gaps.
It did NOT ask: "For each section that SHOULD be in an aspect, is it there?" — because
there is no template or checklist of what a PubSub aspect should contain.

The omission is invisible because:
1. The aspect file is not empty (it has channel naming + payload shape)
2. The aspect is internally consistent (what it says is correct)
3. No method contradicts the timing rule (the rule is simply absent)
4. The agent has no reference for what a "complete" PubSub aspect looks like

### Implications

**The completeness prompt improves method-level coverage detection significantly** (16
high-quality findings vs 14 mixed findings). **But it does NOT solve the aspect-level
omission problem.** To detect missing properties within an aspect, the agent would need
either:

1. **A template/checklist per aspect type** — e.g., "PubSub aspects must document:
   channels, timing, payload, failure behavior, exceptions"
2. **An explicit prompt for aspect review** — "For each aspect, verify it documents
   all properties that a consumer would need to correctly implement the pattern"
3. **Cross-referencing with code patterns** — "The code contains multiple
   `prisma.$transaction` calls that interact with `pubsub.publish`. Does the aspect
   explain the relationship between transactions and publishing?"

### Score Summary

| Metric | Original Exp 9 C2 | Exp 3.1b |
|--------|-------------------|----------|
| Planted omission detected | NO (0%) | NO (0%) |
| Other omissions found | 14 | 16 |
| Quality improvement | — | YES (better severity ranking, more actionable) |
| Method-level completeness | Fair | Good |
| Aspect-level completeness | Not checked | Not checked |
| Overall improvement | Baseline | Marginal — more omissions found but not the target one |

## Conclusion

**The completeness audit prompt is a significant improvement for METHOD-LEVEL completeness**
but **does NOT solve ASPECT-LEVEL completeness checking.** The 0% detection rate for the
planted omission remains unchanged. A different approach is needed — likely an aspect-specific
completeness checklist or template.

This is a product-actionable finding: Yggdrasil could add a `completeness_checklist` field
to aspect schemas, listing the properties that must be documented. The validation step could
then flag aspects that are missing required sections.
