# Exp 3.1b: Completeness Audit Validation

## What We're Testing

In Exp 9, the agent reviewed the C2 graph variant (missing PubSub timing invariant) against
source code and found 0% of omissions. The prompt was: "review graph against source code
for inconsistencies."

The updated agent rules now include a Graph Audit workflow with TWO explicit steps:
1. **Consistency:** "Does the graph accurately describe the code?"
2. **Completeness:** "Does the graph capture all important behavior, invariants, and constraints?"

We test whether the COMPLETENESS prompt catches what the original CONSISTENCY-only prompt missed.

## Experimental Design

### Control: Original prompt (consistency-only)
Same as Exp 9: "Review this graph against the source code for inconsistencies."
Result: 0% omission detection (known from Exp 9 C2)

### Treatment: Completeness audit prompt
New prompt based on the Graph Audit workflow:

"Review this graph for COMPLETENESS against the source code. For each major code behavior,
check whether it is represented in the graph. Specifically:
1. For each public method: is it in the graph?
2. For each error path: is it documented?
3. For each behavioral invariant: is it captured?
4. For each cross-cutting pattern: are all relevant constraints documented?
Report what important code behavior is NOT documented in the graph."

### Materials
- C2 graph variant: experiments/2-concept-test/exp9-materials/C2/
- Source code: /workspaces/hoppscotch/packages/hoppscotch-backend/src/team-collection/team-collection.service.ts
- Target omission: the missing "Timing" section in pubsub-events/content.md

### Success Criteria
- The agent identifies that PubSub timing information is missing from the aspect
- Specifically: events should be published AFTER transaction commit (not inside)
- Specifically: the delete path exception should be mentioned

### Scoring
- DETECTED: Agent explicitly identifies the missing timing invariant
- PARTIALLY DETECTED: Agent identifies PubSub timing as a concern but doesn't specify what's missing
- NOT DETECTED: Agent does not mention PubSub timing at all
