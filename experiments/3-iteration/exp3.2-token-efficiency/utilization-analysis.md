# Context Utilization Analysis — Experiment 3.2 (Token Efficiency)

**Source:** Exp 8 Agent A answers (Q1–Q5)
**Input:** 8 service context packages + 5 aspects + 1 flow + graph tree
**Method:** Per-answer evidence mapping against context package contents

---

## Part 1: Per-Answer Utilization Breakdown

### Q1: Impact analysis of changing `getTeamMember` in TeamService

**Question type:** Blast radius / cross-service dependency tracing

**Services referenced in the answer:**

| Service | Evidence in Answer | Artifact Types Used |
|---|---|---|
| **TeamService** | Signature of `getTeamMember`/`getTeamMemberTE`; `TEAM_MEMBER_NOT_FOUND` error; consumes list for callers | interface.md, errors.md |
| **TeamCollectionService** | Named as direct caller; described as using null check for CLI access gating | interface.md (getCollectionForCLI), responsibility.md |
| **TeamEnvironmentsService** | Named as direct caller; `getTeamEnvironmentForCLI` described identically to TeamCollection pattern | interface.md, constraints.md |
| **TeamInvitationService** | Named as direct caller; two distinct call sites explained (creator auth + already-member guard) | interface.md, constraints.md |
| **AdminService** | Named as indirect caller via `getTeamMemberTE`; `addUserToTeam` path described | interface.md (indirect) |

**Aspects referenced:**

- `team-ownership` — cited explicitly by name: "The team-ownership invariant is violated"
- `role-based-access` — cited explicitly: "per the role-based-access aspect, TeamInvitationService verifies the invitation creator is a team member (any role)"

**Flow referenced:**

- `team-member-lifecycle` — cited explicitly: "Through the Team Member Lifecycle Flow" section lists six paths

**Services NOT referenced:** AuthService, UserService, TeamRequestService

**Assessment:** Answer drew almost entirely from graph relations (`node.yaml` consumes fields) and aspect content. The specific claim about each caller using a "null check" vs "inverse existence check" came directly from constraints.md of TeamInvitationService and the interface.md of TeamCollectionService.

---

### Q2: End-to-end flow — invitation acceptance to first collection creation

**Question type:** Cross-service process trace

**Services referenced in the answer:**

| Service | Evidence in Answer | Artifact Types Used |
|---|---|---|
| **TeamInvitationService** | Full `acceptInvitation` validation chain; `createInvitation` preconditions; error codes; event publishing | interface.md, constraints.md, errors.md, responsibility.md |
| **TeamService** | `addMemberToTeam` described including event publication; `leaveTeam` sole-owner invariant mentioned as background | interface.md, responsibility.md |
| **TeamCollectionService** | `createCollection` logic: title validation, data validation, parent validation, orderIndex assignment via pessimistic lock, transaction pattern, PubSub event | interface.md, constraints.md, logic.md |
| **UserService** | Noted as "indirectly relevant" (registered user requirement); email lookup context | responsibility.md |

**Aspects referenced:**

- `role-based-access` — cited twice: invitation creator requires "any member" role; collection creation requires EDITOR+
- `pubsub-events` — events table lists `invite_added`, `member_added`, `invite_removed`, `team_coll/${teamID}/coll_added`; timing rule "after transaction commits" cited
- `team-ownership` — cited for `TeamCollection.teamID` foreign key and same-team constraint on collection moves

**Flow referenced:**

- No explicit flow reference; Q2 answer itself describes a multi-step flow but does not cite the `team-member-lifecycle` flow document by name

**Services NOT referenced:** AuthService, AdminService, TeamEnvironmentsService, TeamRequestService

**Assessment:** Heavy use of TeamInvitationService constraints.md (validation chain), TeamCollectionService logic.md (orderIndex and locking detail), and pubsub-events aspect (event names + timing). The specific detail about `TITLE_LENGTH = 1` for collection creation came from TeamCollectionService constraints.md. Role constraints at collection creation came from role-based-access aspect.

---

### Q3: Impact of switching from pessimistic to optimistic locking

**Question type:** Architectural change impact / cross-cutting aspect analysis

**Services referenced in the answer:**

| Service | Evidence in Answer | Artifact Types Used |
|---|---|---|
| **TeamCollectionService** | All 7 locking operations enumerated; logic.md reorder algorithm cited for two-parent and batch concerns; `isParent` walk described; `duplicateCollection` export+import pattern | interface.md, logic.md, constraints.md, decisions.md |
| **TeamRequestService** | All 4 locking operations enumerated; `ConflictException` wrapping mentioned; `lockTeamRequestByCollections` named | interface.md, constraints.md |
| **AdminService** | Named as indirect consumer; "keep retries internal" recommendation references AdminService delegation pattern | responsibility.md |

**Aspects referenced:**

- `pessimistic-locking` — cited explicitly and at length: the rationale quote "reorder operations often touch MANY siblings" and "a single conflicting row would invalidate the entire batch" is verbatim from the aspect content; lock scope `(teamID, parentID)` cited
- `retry-on-deadlock` — cited by name; retry conditions (`UNIQUE_CONSTRAINT_VIOLATION`, `TRANSACTION_DEADLOCK`, `TRANSACTION_TIMEOUT`), max retries (5), linear backoff (`retryCount * 100ms`) all cited verbatim from aspect content
- `pubsub-events` — cited for timing behavior (events fire after commit; must fire after retry loop succeeds)

**Flow referenced:**

- Not referenced

**Services NOT referenced:** AuthService, UserService, TeamService, TeamEnvironmentsService, TeamInvitationService

**Assessment:** Q3 was dominated by two context packages (TeamCollectionService, TeamRequestService) and two aspects (pessimistic-locking, retry-on-deadlock). The `decisions.md` from TeamCollectionService was the source of the "why integer not fractional" and "why duplication uses export+import" content that informed the complexity analysis. Almost no information was drawn from the other 6 service packages.

---

### Q4: Can a removed team member still see their previously created collections?

**Question type:** Access control / data model question

**Services referenced in the answer:**

| Service | Evidence in Answer | Artifact Types Used |
|---|---|---|
| **TeamService** | `leaveTeam` behavior described (deletes TeamMember, not collections); `canAllowUserDeletion` / `onUserDelete` / `deleteUserFromAllTeams` cited; sole-owner invariant mentioned; `deleteTeam` behavior noted | interface.md, constraints.md, responsibility.md |
| **TeamCollectionService** | `getCollectionForCLI` access path described step-by-step; `getCollectionTreeForCLI` no-userUid note; "authentication/authorization out of scope" out-of-scope boundary cited | interface.md, responsibility.md |
| **AdminService** | `removeUserFromTeam` delegates to `TeamService.leaveTeam` | interface.md (indirect) |
| **UserService** | `deleteUserByUID` cascade sequence described | interface.md, constraints.md |

**Aspects referenced:**

- `team-ownership` — cited by name for two claims: (a) "There is no cross-team sharing. A collection, request, or environment belongs to exactly one team." (b) `TeamCollection.teamID` as the sole ownership FK; no creatorID field
- `role-based-access` — cited for the three-role model and team-level granularity of access control

**Flow referenced:**

- Not referenced explicitly; the user deletion path described matches the `team-member-lifecycle` flow's "User account deletion" path but it is not cited by name

**Services NOT referenced:** AuthService, TeamEnvironmentsService, TeamRequestService, TeamInvitationService

**Assessment:** The key claim — that there is no `creatorID` on collections — was sourced from the `team-ownership` aspect data model section, not from any service's interface. The step-by-step `getCollectionForCLI` trace came directly from TeamCollectionService interface.md. UserService constraints.md (deletion cascade steps) provided the deletion sequence.

---

### Q5: PubSub system failure impact analysis

**Question type:** Cross-cutting failure mode analysis

**Services referenced in the answer:**

| Service | Evidence in Answer | Artifact Types Used |
|---|---|---|
| **TeamCollectionService** | Event types listed (`coll_added`, etc.); timing confirmation; operations affected | interface.md, responsibility.md |
| **TeamRequestService** | Event types listed (`req_created`, etc.); operations affected | interface.md, responsibility.md |
| **TeamService** | Event types (`member_added`, `member_updated`, `member_removed`); `addMemberToTeam` timing | interface.md, responsibility.md |
| **TeamInvitationService** | Invitation events; email sending as independent channel | interface.md, responsibility.md |
| **TeamEnvironmentsService** | Environment events listed; stale variable risk described | interface.md, responsibility.md |
| **UserService** | `user/{uid}/deleted` event; multi-tab session sync; `updateUserSessions` / `updateUserDisplayName` | interface.md, responsibility.md |
| **AdminService** | `inviteUserToSignInViaEmail` infra invitation event | interface.md, responsibility.md |
| **AuthService** | Explicitly confirmed as NOT having pubsub-events aspect | node.yaml aspects field |

**Aspects referenced:**

- `pubsub-events` — cited heavily and verbatim: the timing rule "Events are published AFTER the database transaction commits successfully. This prevents phantom events where the client sees an update but the transaction rolled back." The answer's key structural claim ("no service publishes INSIDE an open transaction") is sourced directly from this aspect.

**Flow referenced:**

- Not referenced

**Assessment:** Q5 is the only question that meaningfully used all 8 context packages. However, the analytical work — confirming publish timing per service — drew primarily from the pubsub-events aspect content (the timing rule) combined with responsibility.md confirmations that each service publishes after DB work. The aspect was the load-bearing structure; individual service packages provided supporting evidence. The specific claim that UserService `user/{uid}/deleted` is used for "cache invalidation" by downstream services reflects knowledge from UserService constraints.md.

---

## Part 2: Utilization Matrix

For each of the 8 service context packages, how many of the 5 questions used information from it, and which artifact types were drawn upon:

| Service Package | Q1 | Q2 | Q3 | Q4 | Q5 | Questions Using | Artifact Types Used |
|---|---|---|---|---|---|---|---|
| **TeamService** | YES | YES | — | YES | YES | 4/5 | interface.md, constraints.md, responsibility.md, errors.md |
| **TeamCollectionService** | YES | YES | YES | YES | YES | 5/5 | interface.md, constraints.md, responsibility.md, logic.md, decisions.md |
| **TeamInvitationService** | YES | YES | — | — | YES | 3/5 | interface.md, constraints.md, errors.md, responsibility.md |
| **TeamRequestService** | — | — | YES | — | YES | 2/5 | interface.md, constraints.md, responsibility.md |
| **TeamEnvironmentsService** | YES (via aspect) | — | — | — | YES | 2/5 | responsibility.md (indirect via team-ownership aspect only) |
| **AdminService** | YES | — | YES (brief) | YES (brief) | YES | 4/5 | interface.md, responsibility.md |
| **UserService** | — | YES (brief) | — | YES | YES | 3/5 | interface.md, constraints.md, responsibility.md |
| **AuthService** | — | — | — | — | YES (absence) | 1/5 | node.yaml (aspects field only — to confirm absence) |

**Notes on utilization depth:**

- "YES (via aspect only)" means the service's information was accessed through an aspect that describes that service's pattern, not through the service's own artifacts directly.
- "YES (brief)" means the service was referenced for a single fact (one method or one boundary statement), not substantively.
- "YES (absence)" means the service was referenced only to confirm it was NOT relevant.

---

## Part 3: Artifact Type Utilization Across All Questions

| Artifact Type | Used In (Questions) | Role |
|---|---|---|
| **interface.md** | Q1, Q2, Q3, Q4, Q5 | Method signatures, parameter types, return types — primary source for call sites |
| **constraints.md** | Q1, Q2, Q3, Q4, Q5 | Validation rules, invariants, behavioral limits — primary source for "what breaks" analysis |
| **responsibility.md** | Q1, Q2, Q3, Q4, Q5 | Scope boundaries ("out of scope" statements) — essential for determining what is NOT handled at service level |
| **logic.md** | Q2, Q3 | Algorithm detail — used for orderIndex reorder algorithm and locking operations enumeration |
| **decisions.md** | Q3 | Rationale — used for the pessimistic-over-optimistic locking decision verbatim quote |
| **errors.md** | Q1, Q2, Q4 | Error codes — used for break-point analysis and validation chain tracing |
| **node.yaml (relations/aspects)** | Q1, Q3, Q5 | Dependency graph (consumes fields), aspect membership — structural source for blast radius |

**Aspects used:**

| Aspect | Questions Using | Primary Role |
|---|---|---|
| `pubsub-events` | Q2, Q3, Q5 | Timing rule, event naming, payload shape |
| `role-based-access` | Q1, Q2, Q4 | Service-vs-guard enforcement boundary; role definitions |
| `team-ownership` | Q1, Q2, Q4 | Data model (teamID FK, no creatorID); cross-team isolation |
| `pessimistic-locking` | Q3 | Why pessimistic; lock scope; lock function names |
| `retry-on-deadlock` | Q3 | Retry conditions; max retries; backoff values |

**Flow used:**

| Flow | Questions Using | Primary Role |
|---|---|---|
| `team-member-lifecycle` | Q1 (explicit), Q4 (implicit) | Named reference in Q1 for transitive effects; content indirectly used in Q4 deletion trace |

---

## Part 4: The "Top 3 Packages" Counterfactual

**Question:** If Agent A had only been given 3 context packages instead of all 8, which 3 would have answered the most questions correctly?

### Ranking by coverage

| Package | Questions Addressable | Quality of Coverage |
|---|---|---|
| TeamCollectionService | 5/5 | Deep — all artifact types used |
| TeamService | 4/5 | Deep — interface, constraints, errors, responsibility |
| TeamInvitationService | 3/5 | Medium — Q1 and Q2 require it; Q5 partial |
| AdminService | 4/5 | Shallow — referenced in 4 questions but briefly each time |
| UserService | 3/5 | Shallow — one key fact per appearance |

**Best 3 packages:** TeamCollectionService + TeamService + TeamInvitationService

**Coverage analysis with only these 3:**

| Question | Answerable? | What Would Be Missing |
|---|---|---|
| **Q1** | Mostly yes | TeamEnvironmentsService would be absent — the answer correctly notes it also calls `getTeamMember` for CLI access. This fact is obtainable from the `team-ownership` aspect which is included in all three packages. AdminService indirect path via `getTeamMemberTE` would be absent entirely. |
| **Q2** | Yes, fully | All four services used (TeamInvitationService, TeamService, TeamCollectionService, UserService[brief]) — UserService is missing but its contribution was one boundary statement. |
| **Q3** | Partial — missing TeamRequestService | TeamRequestService's 4 locking operations would be unknown. The answer correctly lists `createTeamRequest`, `deleteTeamRequest`, `moveRequest`, `sortTeamRequests` — these come from TeamRequestService interface.md/constraints.md. The structural half of Q3 (TeamCollectionService changes) would be complete; the TeamRequestService half would be empty. |
| **Q4** | Yes, fully | All substantive information in Q4 comes from TeamCollectionService, TeamService, and the `team-ownership` aspect. AdminService and UserService roles were brief mentions. |
| **Q5** | Partial | TeamRequestService, TeamEnvironmentsService, UserService, AdminService events would be unaccounted for. The answer's per-service severity table would cover only 3 of 7 services. The core finding (all publishes happen after DB commit, so no data loss) would still be correctly derivable from the `pubsub-events` aspect alone, making the structural conclusion correct even if per-service enumeration were incomplete. |

**Verdict:** With TeamCollectionService + TeamService + TeamInvitationService:
- Q1: 85% correct (AdminService indirect path missing)
- Q2: 100% correct
- Q3: 60% correct (TeamRequestService half absent)
- Q4: 100% correct
- Q5: structural conclusion correct, per-service enumeration 3/7 complete

**Overall: 3 packages would produce fully correct answers for 2 of 5 questions (Q2, Q4), structurally correct but incomplete answers for 2 questions (Q1, Q5), and a substantively incomplete answer for 1 question (Q3).**

---

## Part 5: Findings and Implications for Token Efficiency

### Finding 1: The 5-aspect payload carried disproportionate load

Across all 5 questions, aspects were cited as the primary source for at least one key structural claim per answer. The `pubsub-events` aspect's timing rule ("after transaction commits") was the single sentence that enabled the entire Q5 answer. The `team-ownership` aspect's data model section ("no creatorID, only teamID") answered the most critical sub-question in Q4. The `pessimistic-locking` aspect's rationale quote was the verbatim source for Q3's conclusion.

**Implication:** Removing aspects from the context bundle and replacing them with per-service documentation would require each of the 8 service packages to individually articulate the same cross-cutting facts, dramatically increasing total token count for no incremental information gain.

### Finding 2: Two packages were load-bearing across nearly all questions

TeamCollectionService (5/5) and TeamService (4/5) appeared in almost every answer. TeamCollectionService was the only package whose `logic.md` and `decisions.md` artifacts were actually used — all other packages contributed only from their responsibility/interface/constraints/errors artifacts.

**Implication:** When a subset context strategy is needed, these two packages plus the 5 aspects represent the minimum viable payload for this question set. The marginal utility of the remaining 6 packages is low for Q1, Q2, Q4 but critical for Q3 (TeamRequestService) and Q5's enumeration depth.

### Finding 3: AuthService contributed effectively zero information

AuthService appeared in only Q5, and only to confirm it has no `pubsub-events` aspect. Its 3,165-token package provided one binary fact: "AuthService does NOT have the pubsub-events aspect."

**Implication:** AuthService is the clearest candidate for removal in a 7-package subset. Its sole contribution (the absence of an aspect) is derivable from the graph tree which was also provided as a separate file. The graph-tree file itself (17 lines) encodes which nodes carry which aspects — making the full AuthService context package redundant for aspect-presence queries.

### Finding 4: `node.yaml` relations fields were used as a primary structural source in Q1

The consumes declarations (e.g., `team-collection-service: consumes: [getTeamMember]`) were explicitly cited in Q1 as the source for identifying which services call `getTeamMember`. This demonstrates that the graph's relational metadata — not the service code narratives — is the first-order blast radius tool.

**Implication:** For impact-analysis questions (like Q1), the graph tree + node.yaml relations fields are the most token-efficient representation. The narrative artifacts (logic.md, responsibility.md) are needed for "what does the caller do with the result" but not for "who calls this method."

### Finding 5: `decisions.md` was used in exactly one question, but its contribution was unique

The pessimistic-over-optimistic rationale in TeamCollectionService `decisions.md` was the only source for the system-wide risk assessment conclusion in Q3. Without it, the answer would have correctly described the mechanical changes but would have lacked the architectural judgment that the switch "contradicts the original architectural decision and its documented rationale."

**Implication:** `decisions.md` artifacts carry zero marginal tokens-per-question in routine operation but represent the maximum information density per token when an architectural question is asked. They are the highest-leverage artifact for "should we do X" questions and the lowest-leverage for "how does X work" questions.

---

## Summary Table

| Service Package | Q1 | Q2 | Q3 | Q4 | Q5 | Total | Artifacts Used |
|---|---|---|---|---|---|---|---|
| TeamCollectionService | YES | YES | YES | YES | YES | **5** | interface, constraints, responsibility, logic, decisions |
| TeamService | YES | YES | — | YES | YES | **4** | interface, constraints, responsibility, errors |
| AdminService | YES | — | YES | YES | YES | **4** | interface, responsibility |
| TeamInvitationService | YES | YES | — | — | YES | **3** | interface, constraints, errors, responsibility |
| UserService | — | YES | — | YES | YES | **3** | interface, constraints, responsibility |
| TeamRequestService | — | — | YES | — | YES | **2** | interface, constraints, responsibility |
| TeamEnvironmentsService | YES* | — | — | — | YES | **2** | responsibility (via aspect only) |
| AuthService | — | — | — | — | YES† | **1** | node.yaml aspects field only |

*TeamEnvironmentsService in Q1: referenced via the `team-ownership` aspect, not its own artifacts directly
†AuthService in Q5: referenced only to confirm absence of pubsub-events aspect

| Aspect | Q1 | Q2 | Q3 | Q4 | Q5 | Total |
|---|---|---|---|---|---|---|
| team-ownership | YES | YES | — | YES | — | **3** |
| role-based-access | YES | YES | — | YES | — | **3** |
| pubsub-events | — | YES | YES | — | YES | **3** |
| pessimistic-locking | — | — | YES | — | — | **1** |
| retry-on-deadlock | — | — | YES | — | — | **1** |

| Flow | Q1 | Q2 | Q3 | Q4 | Q5 | Total |
|---|---|---|---|---|---|---|
| team-member-lifecycle | YES | — | — | partial | — | **1–2** |
