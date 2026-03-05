## Logic

# Validator Logic

## validate(scope)

1. **Early errors**: configError → E012; nodeParseErrors → E001
2. **Config-dependent checks** (if !configError): checkNodeTypes, checkAspectsDefined, checkAspectIds, checkAspectIdUniqueness, checkImpliedAspectsExist, checkImpliesNoCycles, checkRequiredAspectsCoverage, checkAnchorPresence, checkRequiredArtifacts, checkInvalidArtifactConditions, checkContextBudget, checkHighFanOut
3. **Graph-structure checks**: checkRelationTargets, checkNoCycles, checkMappingOverlap, checkMappingPathsExist, checkBrokenFlowRefs, checkFlowAspectIds, checkDirectoriesHaveNodeYaml, checkShallowArtifacts, checkUnpairedEvents
4. **Scope filter**: if scope !== 'all', filter issues by nodePath; validate scope exists

## Key rules

- **checkSchemas**: REQUIRED_SCHEMAS = ['node','aspect','flow']; present = Set(graph.schemas.map(s => s.schemaType)); missing → W010
- **checkNoCycles**: DFS with WHITE/GRAY/BLACK; cycles involving blackbox tolerated
- **checkImpliedAspectsExist**: each id in aspect.implies must have corresponding aspect → E016
- **checkImpliesNoCycles**: DFS on aspect implies graph; cycle → E017
- **checkRequiredAspectsCoverage**: node type with required_aspects; coverage via direct aspect or resolveAspects → W011
- **checkRequiredArtifacts**: artifactRequiredReason evaluates required (always | never | when conditions)
- **checkContextBudget**: buildContext per node; compare tokenCount to warning/error thresholds
- **checkAnchorPresence**: For each node with aspect entries containing `anchors`, validates W014 — each anchor string must appear in at least one mapped source file. Uses `expandMappingToFiles` helper to recursively collect files from mapping paths (skips dotfiles and `node_modules`). All source files for a node are read once and searched for each anchor string via simple `content.includes(anchor)`. E018 (invalid-aspect-exception) and E019 (invalid-anchor-ref) were removed — the unified aspects format makes structurally invalid references impossible.

## Order of checks

Config-dependent first (need valid config). Structure checks can run with partial config. Scope filter applied last.

## Decisions

# Validator Decisions

**Stable error codes E001-E019, W001-W014:** Each validation rule has a fixed code (E for errors, W for warnings). These codes are machine-readable identifiers stable across versions, enabling CI pipelines and automation to match on specific codes rather than fragile message text. New rules receive the next available code.

**Warnings do not block build-context:** Warnings (W-codes) indicate quality suggestions such as shallow artifacts, high fan-out, or missing optional coverage. Errors (E-codes) indicate structural integrity failures such as broken relations, missing node.yaml, or cycles. Only errors represent states where the graph is structurally invalid. build-context operates on the loaded graph and does not consult validation results, so warnings never prevent context assembly.
