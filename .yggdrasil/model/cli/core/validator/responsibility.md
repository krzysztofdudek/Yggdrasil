# Validator Responsibility

Structural validation and completeness checks. Implements E001–E017 (errors) and W001–W002, W005–W007, W009–W011 (warnings). Enforces invariants/001 (context sufficient) and invariants/002 (graph intended truth). Aligns with decisions/001 (read-only; reports issues, does not modify graph).

**In scope:**

- `validate(graph, scope?)`: scope 'all' or node path. Returns ValidationResult (issues, nodesScanned). Structural errors block build-context.
- **Errors**: E001 (invalid-node-yaml), E002 (unknown-node-type), E003 (unknown-tag), E004 (broken-relation), E006 (broken-flow-ref), E007 (broken-aspect-tag), E009 (overlapping-mapping), E010 (structural-cycle), E012 (invalid-config), E013 (invalid-artifact-condition), E014 (duplicate-aspect-binding), E015 (missing-node-yaml), E016 (implied-aspect-missing), E017 (aspect-implies-cycle).
- **Warnings**: W001 (missing-artifact), W002 (shallow-artifact), W005 (budget-warning), W006 (budget-error), W007 (high-fan-out), W009 (unpaired-event), W010 (missing-schema), W011 (missing-required-tag-coverage).
- E010: cycles involving at least one blackbox node are tolerated. W005/W006: uses buildContext for token count. W010: checks that node, aspect, flow schemas are present in templates/. W011: uses expandAspectsForTags for coverage (direct tag or via implies).
- **Internal checks**: checkSchemas, checkNodeTypes, checkRelationTargets, checkTagsDefined, checkAspectTags, checkAspectTagUniqueness, checkImpliedAspectsExist, checkImpliesNoCycles, checkRequiredTagsCoverage, checkNoCycles, checkMappingOverlap, checkRequiredArtifacts, checkBrokenFlowRefs, checkInvalidArtifactConditions, checkShallowArtifacts, checkHighFanOut, checkUnpairedEvents, checkDirectoriesHaveNodeYaml, checkContextBudget. findSimilar: suggests similar node_path for E004.

**Out of scope:**

- Graph loading (cli/core/loader)
- Context building (cli/core/context) — validator consumes buildContext for budget check only
