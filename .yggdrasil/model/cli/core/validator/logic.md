# Validator Logic

## validate(scope)

1. **Early errors**: configError → E012; nodeParseErrors → E001
2. **Config-dependent checks** (if !configError): checkNodeTypes, checkTagsDefined, checkAspectTags, checkAspectTagUniqueness, checkImpliedAspectsExist, checkImpliesNoCycles, checkRequiredTagsCoverage, checkRequiredArtifacts, checkInvalidArtifactConditions, checkContextBudget, checkHighFanOut, checkSchemas
3. **Graph-structure checks**: checkRelationTargets, checkNoCycles, checkMappingOverlap, checkBrokenFlowRefs, checkDirectoriesHaveNodeYaml, checkShallowArtifacts, checkUnpairedEvents
4. **Scope filter**: if scope !== 'all', filter issues by nodePath; validate scope exists

## Key rules

- **checkSchemas**: REQUIRED_SCHEMAS = ['node','aspect','flow']; present = Set(graph.schemas.map(s => s.schemaType)); missing → W010
- **checkNoCycles**: DFS with WHITE/GRAY/BLACK; cycles involving blackbox tolerated
- **checkImpliedAspectsExist**: each tag in aspect.implies must have corresponding aspect → E016
- **checkImpliesNoCycles**: DFS on aspect implies graph; cycle → E017
- **checkRequiredTagsCoverage**: node type with required_tags; coverage via direct tag or expandAspectsForTags → W011
- **checkRequiredArtifacts**: artifactRequiredReason evaluates required (always | never | when conditions)
- **checkContextBudget**: buildContext per node; compare tokenCount to warning/error thresholds

## Order of checks

Config-dependent first (need valid config). Structure checks can run with partial config. Scope filter applied last.
