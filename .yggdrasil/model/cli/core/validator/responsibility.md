# Validator Responsibility

Structural validation and completeness checks. Implements error/warning scheme: E001-E013 (structural errors), E030-E039 (completeness errors), E050-E053 (aspect/architecture errors), W001-W005 (warnings). Enforces invariants/001 (context sufficient) and invariants/002 (graph intended truth). Aligns with decisions/001 (read-only; reports issues, does not modify graph).

**In scope:**

- `validate(graph, scope?)`: scope 'all' or node path. Returns ValidationResult (issues, nodesScanned). Errors block build-context.
- **Structural errors**: E001 (invalid-node-yaml), E002 (unknown-node-type), E004 (broken-relation), E005 (broken-flow-ref), E006 (broken-aspect-ref), E007 (overlapping-mapping), E008 (structural-cycle), E009 (invalid-config), E010 (duplicate-aspect-binding), E011 (missing-node-yaml), E012 (implied-aspect-missing), E013 (aspect-implies-cycle).
- **Completeness errors**: E030 (missing-artifact), E031 (shallow-artifact), E032 (budget-exceeded), E033 (unpaired-event), E034 (missing-schema), E036 (mapping-path-missing), E038 (missing-description).
- **Aspect/architecture errors**: E050 (dangling-aspect-ref — node/port/architecture/flow aspect has no definition), E051 (invalid-relation-target), E052 (invalid-parent-type), E053 (integration-aspect-missing — port's required aspect not defined).
- **Removed codes**: E003 (replaced by E050), E037 (anchor-not-found — replaced by LLM aspect verification), E039 (aspect-missing-claims — claims removed), E040 (anchor-not-realized — replaced by LLM aspect verification), E041 (unknown-anchor-type — removed with regex anchors), W013, W014.
- **Warnings**: W001 (budget-warning, informational with breakdown), W002 (own-budget-warning), W003 (wide-node), W004 (high-fan-out).
- E008: cycles involving at least one blackbox node are tolerated. W001/E032: uses buildContext for token count, includes per-category breakdown via computeBudgetBreakdown. W002: fires when own-layer tokens exceed own_warning threshold. E034: checks that node, aspect, flow schemas are present in schemas/.
- **Internal checks**: checkNodeTypes, checkDanglingAspectRefs, checkAspectIds, checkAspectIdUniqueness, checkImpliedAspectsExist, checkImpliesNoCycles, checkRequiredArtifacts, checkContextBudget, checkHighFanOut, checkWideNodes, checkMissingDescriptions, checkSchemas, checkRelationTargets, checkNoCycles, checkMappingOverlap, checkMappingPathsExist, checkBrokenFlowRefs, checkFlowAspectIds, checkDirectoriesHaveNodeYaml, checkShallowArtifacts, checkUnpairedEvents, checkArchitectureConstraints, checkPortAspectsDefined. findSimilar: suggests similar node_path for E004. expandMappingToFiles: recursively collects files from mapping paths for wide-node validation.

**Out of scope:**

- Consumes buildContext only for budget calculation — does not participate in context assembly.
