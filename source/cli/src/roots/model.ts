/**
 * Roots convention-mining configuration — every top-level section the roots
 * engine reads, always fully populated once `YggConfig.roots` is present (the
 * parser fills any key the adopter's `roots:` block omits with its documented
 * default). Field meanings and defaults are documented once, at the parser's
 * `DEFAULT_ROOTS` constant (`io/config-parser.ts`) — this type only fixes the
 * shape both the parser and the roots engine agree on.
 */
export interface RootsConfig {
  include: string[];
  exclude: string[];
  partition: { mode: string };
  history: {
    full: boolean;
    windowMonths: number;
    maxCommits: number;
    megaCommitFileCap: number;
    churnEarlyDays: number;
    blobMaxBytes: number;
    lifecycleFileMaxKb: number;
    lifecycleMaxAppearances: number;
    agentIdentities: string[];
  };
  enumerate: {
    support: { nodeType: number; call: number; import: number; supertype: number; shape: number; decorator: number };
    topK: { nodeType: number; call: number; import: number; supertype: number; shape: number; decorator: number };
    shapeDepth: number;
    shapeMaxStatements: number;
    pathSegments: number;
    localVarSampleMax: number;
  };
  weights: {
    survivalFullDays: number;
    freshPenaltyDays: number;
    agentBase: number;
    agentPromoteDays: number;
    baseFloor: number;
    hookShapedWeight: number;
    noLifecycleWeight: number;
    dirtyWeight: number;
    seedDefaultWeight: number;
    seedCapFraction: number;
  };
  mdl: {
    acceptMarginBits: number;
    minInstancesRaw: number;
    minInstancesEff: number;
    factCap: number;
    dedupJaccard: number;
    dirContextMinScopes: number;
  };
  thresholds: {
    preferenceGapBits: number;
    absenceGapBits: number;
    absenceGapBitsStructural: number;
    eligibilityMinRawShare: number;
    denyExtraBits: number;
    denyMinPrecision: number;
    roleAmbiguityGap: number;
    roleMinMembership: number;
    couplingPercentileForDeny: number;
  };
  calib: {
    horizonDays: number;
    settleDays: number;
    minEventsConvention: number;
    minEventsFamily: number;
    minEventsDeny: number;
    targetPrecision: number;
  };
  trend: {
    windowDays: number;
    windowCount: number;
    maxWindows: number;
    attractorSlopeK: number;
    lowSampleMin: number;
    cohortBy: string;
    nucleation: { minSlopePerQuarter: number; minWindows: number; minHumanAuthors: number };
  };
  cochange: { minSupport: number; minConfidence: number; maxPairs: number };
  ledger: { releaseStableDays: number; releaseMinDaysAfterMark: number };
  budgets: {
    maxMessagesPerResponse: number;
    sessionMaxWarnings: number;
    hookHardTimeoutMs: number;
    hookColdBudgetMs: number;
    daemonBudgetMs: number;
    bashSweepDebounceMs: number;
    bashSweepMaxFiles: number;
    bashFloodThreshold: number;
  };
  health: { minCompliance: number; minSamples: number; telemetryRetentionDays: number; agentShareAlarm: number };
  completeness: { mode: string; maxItems: number };
  seed_tension: { minFc: number; minN: number };
  report: { topFacts: number };
  hooks: {
    claudeCode: {
      postTool: boolean;
      preTool: boolean;
      bash: boolean;
      userPromptBrief: boolean;
      stopCompleteness: boolean;
    };
  };
  roles: {
    clusterSampleCap: number;
    reinduceTouchedFraction: number;
    reinduceTouchedMin: number;
    minClusterSize: number;
    minOwnFeatures: number;
    cloneMedoidJaccard: number;
  };
  sessions: { pruneDays: number };
}

/**
 * One line of the committed, append-only `seeds.jsonl` store — a maintainer's
 * authored prior nudging the mined statistics toward a named scope's surfaces.
 * The record type CROSSES the roots-engine/roots-store boundary: `stores.ts`
 * (roots-store) reads seeds.jsonl typed as `SeedEntry[]`, and the mining engine
 * (roots-engine) consumes those values as an explicit parameter — never by
 * importing the store itself, since the roots-engine relation allowlist has no
 * roots-store edge. Declared in the types layer (this file) so both sides
 * import the same shape without either depending on the other.
 */
export interface SeedEntry {
  /** sha256(scopeStableId ∥ author ∥ createdAt), truncated to 16 hex chars. */
  seedId: string;
  scopeRef: { path: string; qualifiedName: string };
  /** The mined surfaces this seed nudges (e.g. `call`, `import`, `decorator`). */
  surfaces: string[];
  weight: number;
  /** Whether this seed encodes an architectural (structural) preference. */
  arch: boolean;
  note?: string;
  author: string;
  createdAt: string;
}

/**
 * One line of the committed, append-only `ledger.jsonl` store (spec §18.3,
 * `v6-spec.md:685`) — a hook-shaped mark: "roots records that it shaped this
 * code". The record type CROSSES the roots-engine/roots-store boundary the
 * same way `SeedEntry` does: `stores.ts` (roots-store) reads `ledger.jsonl`
 * typed as `LedgerEntry[]`, and the mining engine (roots-engine) consumes
 * those values as an explicit parameter — never by importing the store
 * itself, since the roots-engine relation allowlist has no roots-store edge.
 * Declared in the types layer (this file) so both sides import the same
 * shape without either depending on the other.
 */
export interface LedgerEntry {
  /** The marked scope's CURRENT `stable_id` at lookup time (D6) — aliases are followed for renames by the reader, never stored pre-resolved here. */
  stableId: string;
  /** The mined surface the mark caps (§9.1's `w(s,q)` is per (scope, surface)). */
  surface: string;
  /** ISO-8601 mark date — the release clause's `markDate` input (§18.3). */
  date: string;
}
