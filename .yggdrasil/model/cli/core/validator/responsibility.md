# Validator Responsibility

Structural validation and completeness checks. Implements E001–E015, E017 (errors) and W001–W010 (warnings). Enforces invariants/001 (context sufficient) and invariants/002 (graph intended truth). Aligns with decisions/001 (read-only; reports issues, does not modify graph).

**In scope:**

- `validate(graph, scope?)`: scope 'all' or node path. Returns ValidationResult (issues, nodesScanned). Structural errors block build-context.
- **Errors**: E001 (invalid-node-yaml), E002 (unknown-node-type), E003 (unknown-tag), E004 (broken-relation), E005 (broken-knowledge-ref), E006 (broken-flow-ref), E007 (broken-aspect-tag), E008 (broken-scope-ref), E009 (overlapping-mapping), E010 (structural-cycle), E011 (unknown-knowledge-category), E012 (invalid-config), E013 (invalid-artifact-condition), E014 (duplicate-aspect-binding), E015 (missing-node-yaml), E017 (missing-knowledge-category-dir).
- **Warnings**: W001 (missing-artifact), W002 (shallow-artifact), W003 (unreachable-knowledge), W004 (missing-example), W005 (budget-warning), W006 (budget-error), W007 (high-fan-out), W008 (stale-knowledge), W009 (unpaired-event), W010 (missing-schema).
- E010: cycles involving at least one blackbox node are tolerated. W005/W006: uses buildContext for token count. W008: uses Git commit timestamps (getLastCommitTimestamp). W010: checks that node, aspect, flow, knowledge schemas are present in templates/.
- **Internal checks**: checkSchemas, checkNodeTypes, checkRelationTargets, checkTagsDefined, checkAspectTags, checkAspectTagUniqueness, checkNoCycles, checkMappingOverlap, checkRequiredArtifacts, checkBrokenKnowledgeRefs, checkBrokenFlowRefs, checkBrokenScopeRefs, checkScopeTagsDefined, checkUnknownKnowledgeCategories, checkInvalidArtifactConditions, checkShallowArtifacts, checkUnreachableKnowledge, checkMissingPatternExamples, checkHighFanOut, checkStaleKnowledge, checkUnpairedEvents, checkDirectoriesHaveNodeYaml, checkContextBudget. findSimilar: suggests similar node_path for E004.

**Out of scope:**

- Graph loading (cli/core/loader)
- Context building (cli/core/context) — validator consumes buildContext for budget check only
