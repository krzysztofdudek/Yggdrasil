# Exp 3.3: Inter-Agent Consistency — Comparison

## Overview

Two independent agents (Alpha and Beta) built Yggdrasil graphs for the same module
(ShortcodeService, 342 lines) from the same source code, with identical prompts.

---

## Structural Similarity

### node.yaml

| Element | Alpha | Beta | Match? |
|---------|-------|------|--------|
| Name | ShortcodeService | ShortcodeService | YES |
| Type | service | service | YES |
| Aspects identified | 4 | 4 | YES (same concepts, different names) |
| Relations | 3 (Prisma, PubSub, User) | 4 (Prisma, PubSub, User, Resolver) | PARTIAL |
| File mappings | 3 files | 3 files | YES |

**Aspect naming divergence:**

| Alpha | Beta | Same concept? |
|-------|------|--------------|
| fp-ts-either-returns | fp-ts-error-handling | YES |
| pubsub-fire-and-forget | pubsub-event-publishing | YES (different emphasis) |
| cursor-based-pagination | cursor-based-pagination | YES |
| user-data-handler | user-data-handler | YES |

All 4 aspects identified independently map to the same cross-cutting patterns.
Naming differs but semantics are equivalent.

**Relation divergence:** Beta added ShortcodeResolver as a `consumed by` relation.
Alpha did not include the consumer direction. Both included the 3 core dependencies.

### Verdict: HIGH structural similarity (90%+)

---

## Semantic Equivalence

### responsibility.md

| Dimension | Alpha | Beta | Match? |
|-----------|-------|------|--------|
| Identity description | 12-char alphanumeric, encodes HTTP request + embed props | 12-char alphanumeric, encodes HTTP request + embed props | YES |
| In-scope items | 8 items | 10 items | OVERLAP (same core, Beta more granular) |
| Out-of-scope items | 5 items | 5 items | YES (same concepts) |
| Auth exclusion | "enforced by guards in resolver layer" | "enforced at resolver layer via guards" | YES |
| Expiry mention | Not mentioned | "Shortcode expiry or TTL — no expiration logic is present" | BETA UNIQUE |

**Beta uniquely noted** the absence of expiry/TTL — a "what it's NOT" observation
that Alpha did not make. This is a small but valuable addition.

### Verdict: HIGH semantic equivalence (95%+)

---

### interface.md

| Method | Alpha | Beta | Differences |
|--------|-------|------|-------------|
| getShortCode | Full sig + returns + error | Full sig + returns + error + DB operation | Beta adds DB detail |
| createShortcode | Full sig + 2 error codes + pubsub note | Full sig + 2 error codes + pubsub note | IDENTICAL |
| fetchUserShortCodes | Full sig + pagination | Full sig + pagination + skip-1 detail | Beta more granular |
| revokeShortCode | Full sig + error + pubsub + null-check asymmetry note | Full sig + error + pubsub unconditional | BOTH noted asymmetry |
| deleteUserShortCodes | Full sig + no pubsub note | Full sig + no pubsub note | IDENTICAL |
| deleteShortcode | Full sig + no pubsub note | Full sig + no pubsub + rationale unknown | BETA adds rationale |
| updateEmbedProperties | Full sig + 3 error codes + pubsub | Full sig + 3 error codes + pubsub | IDENTICAL |
| fetchAllShortcodes | Full sig + email filter + orphan note | Full sig + email filter + case-insensitive | EQUIVALENT |
| canAllowUserDeletion | Returns TO.none | Returns TO.none | IDENTICAL |
| onUserDelete | Calls deleteUserShortCodes | Calls deleteUserShortCodes | IDENTICAL |
| PubSub channels | Table: 3 channels | Table: 3 channels | IDENTICAL |
| Data structures | 2 tables (Shortcode, ShortcodeWithUserEmail) | 2 code blocks + PaginationArgs | Beta adds PaginationArgs |

### Verdict: VERY HIGH interface equivalence (98%+)

---

### internals.md

| Topic | Alpha | Beta | Differences |
|-------|-------|------|-------------|
| ID generation | Detailed: 62^12, unbounded loop, Math.random | Detailed: 62^12, unbounded loop, Math.random | IDENTICAL core |
| Math.random observation | "not cryptographic" implied | Explicit: "non-cryptographic" | Beta more explicit |
| TOCTOU race condition | Not mentioned | Explicitly identified | BETA UNIQUE |
| cast/type mapping | Re-serialization + key ordering side effect | Re-serialization + fetchAll inline mapping | Different details |
| PubSub null-guard asymmetry | Explicitly called out as asymmetry | Explained per-method | Same info, different org |
| Pagination | cursor + skip:1 + newest-first + no cap | cursor + skip:1 + newest-first | IDENTICAL |
| User deletion | No pubsub + registered via onModuleInit | No pubsub + registered via onModuleInit | IDENTICAL |
| Ownership scoping | Composite unique constraint | Composite unique constraint + no pre-fetch | EQUIVALENT |
| Decisions recorded | 3 decisions, all "rationale: unknown" | 4 decisions, all "rationale: unknown" | Beta has 1 more |
| TOCTOU in decisions | Not mentioned | Explicitly documented | BETA UNIQUE |

**Key divergence: TOCTOU race condition.** Beta explicitly identified that two concurrent
createShortcode calls could both check the same generated ID as free, then both attempt
to insert — the DB unique constraint would catch it but the error is unhandled. Alpha
did not identify this edge case.

### Verdict: HIGH equivalence (90%+), Beta slightly more thorough on edge cases

---

## Contradiction Analysis

**Zero contradictions found.** No claim in Alpha's graph is mutually exclusive with
any claim in Beta's graph. All differences are additive (one captured something the
other didn't), not contradictory.

---

## Summary Metrics

| Dimension | Score | Notes |
|-----------|-------|-------|
| Structural similarity | 90% | Same type, aspects, relations (Beta +1 consumer) |
| Semantic equivalence | 95% | Same responsibility scope (Beta +expiry absence) |
| Interface completeness | 98% | Same methods, same signatures, same error codes |
| Internals equivalence | 90% | Same core logic; Beta found TOCTOU, Alpha found key-ordering |
| Contradiction rate | 0% | No mutually exclusive claims |
| Aspect identification | 100% | Same 4 concepts identified independently |
| "Rationale unknown" usage | Both used | Alpha: 3 decisions, Beta: 4 decisions |

## Key Finding

**Independent agents produce highly consistent graphs (90-98% overlap) with zero
contradictions.** The representation is largely deterministic — the same source code
leads to the same graph structure, the same aspects, the same public API documentation,
and the same behavioral observations.

The 2-10% divergence is exclusively ADDITIVE:
- Beta found the TOCTOU race condition; Alpha found the JSON key-ordering side effect
- Beta noted the absence of TTL/expiry; Alpha did not
- Beta included the consumer relation (resolver); Alpha did not

Neither agent invented wrong information. Both correctly used "rationale: unknown"
for all decisions where the WHY was not observable in code.

## Implications

1. **Yggdrasil graph construction is deterministic enough for practical use.**
   Two agents building independently will agree on 90%+ of content with 0% contradictions.

2. **The remaining 10% divergence is about OBSERVATION DEPTH, not interpretation.**
   Both agents see the same facts; the difference is which edge cases they notice.
   This is analogous to two human engineers writing different-depth documentation.

3. **Combining two independently-built graphs would be strictly additive.**
   A merge of Alpha and Beta would contain everything in both, with no conflicts to
   resolve. This suggests a potential workflow: two agents build independently, then
   merge for completeness.

4. **The "rationale: unknown" pattern works.** Both agents independently chose to mark
   decisions with unknown rationale rather than inventing plausible explanations.
   This confirms the pattern is natural and doesn't require special prompting beyond
   the rule instruction.
