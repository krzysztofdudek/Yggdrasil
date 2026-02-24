# Validator Logic

## validate(scope)

1. **Early errors**: configError → E012; nodeParseErrors → E001
2. **Config-dependent checks** (if !configError): checkNodeTypes, checkTagsDefined, checkAspectTags, checkAspectTagUniqueness, checkRequiredArtifacts, checkUnknownKnowledgeCategories, checkInvalidArtifactConditions, checkScopeTagsDefined, checkMissingPatternExamples, checkContextBudget, checkHighFanOut, checkStaleKnowledge, checkSchemas
3. **Graph-structure checks**: checkRelationTargets, checkNoCycles, checkMappingOverlap, checkBrokenKnowledgeRefs, checkBrokenFlowRefs, checkBrokenScopeRefs, checkDirectoriesHaveNodeYaml, checkShallowArtifacts, checkUnreachableKnowledge, checkUnpairedEvents
4. **Scope filter**: if scope !== 'all', filter issues by nodePath; validate scope exists

## Key rules

- **checkSchemas**: REQUIRED_SCHEMAS = ['node','aspect','flow','knowledge']; present = Set(graph.schemas.map(s => s.schemaType)); missing → W010
- **checkNoCycles**: DFS with WHITE/GRAY/BLACK; cycles involving blackbox tolerated
- **checkRequiredArtifacts**: artifactRequiredReason evaluates required (always | never | when conditions)
- **checkStaleKnowledge**: Git commit timestamps; tK (knowledge) vs max(tP) for scope nodes; diffDays > staleness_days → W008
- **checkContextBudget**: buildContext per node; compare tokenCount to warning/error thresholds

## Order of checks

Config-dependent first (need valid config). Structure checks can run with partial config. Scope filter applied last.
