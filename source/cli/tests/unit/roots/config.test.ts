import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConfig, ConfigParseError } from '../../../src/io/config-parser.js';
import { rootsConfigHash } from '../../../src/roots/config.js';
import type { RootsConfig, YggConfig } from '../../../src/model/graph.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/config.test.ts — the `roots:` config seam, driven through
// the PUBLIC parseConfig (real yg-config.yaml files in real tmp dirs), the
// same way the established signals:/events: sections are tested. Also covers
// rootsConfigHash (src/roots/config.ts), the pure sha256-of-canonical-JSON
// fold over a parsed RootsConfig.
// ---------------------------------------------------------------------------

const dirsToCleanup: string[] = [];
afterEach(async () => {
  for (const d of dirsToCleanup.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Write a config body (already including a version) to a fresh tmp dir and parse it. */
async function parseWith(body: string): Promise<YggConfig> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yg-roots-config-'));
  dirsToCleanup.push(dir);
  const filePath = path.join(dir, 'yg-config.yaml');
  await writeFile(filePath, `version: "5.2.0"\n${body}`, 'utf-8');
  return parseConfig(filePath, { skipSecretsOverlay: true });
}

describe('roots config — absent block (dormancy)', () => {
  it('a config with no roots: key parses with config.roots undefined', async () => {
    const cfg = await parseWith('');
    expect(cfg.roots).toBeUndefined();
  });

  it('a config with unrelated sections but no roots: key still leaves config.roots undefined', async () => {
    const cfg = await parseWith('quality:\n  max_direct_relations: 5\n');
    expect(cfg.roots).toBeUndefined();
  });
});

describe('roots config — minimal block gets full defaults', () => {
  it('an empty roots: {} mapping fills every key with its documented default', async () => {
    const cfg = await parseWith('roots: {}\n');
    expect(cfg.roots).toBeDefined();
    const roots = cfg.roots as RootsConfig;

    // Spot-check one leaf from each of the twenty top-level sections — full
    // section-by-section defaults are exercised by the "leaves default when
    // omitted alongside an explicit sibling" tests below.
    expect(roots.include).toEqual(['**/*']);
    expect(roots.exclude).toEqual([]);
    expect(roots.partition).toEqual({ mode: 'auto' });
    expect(roots.history.full).toBe(true);
    expect(roots.history.windowMonths).toBe(24);
    expect(roots.history.agentIdentities).toEqual([
      'claude', 'copilot', 'cursor', 'codex', 'devin', '\\bbot\\b', 'gpt', 'gemini', 'dependabot',
    ]);
    expect(roots.enumerate.support).toEqual({ nodeType: 20, call: 8, import: 5, supertype: 4, shape: 15, decorator: 8 });
    expect(roots.enumerate.topK.call).toBe(80);
    expect(roots.weights.seedDefaultWeight).toBe(8);
    expect(roots.weights.seedCapFraction).toBe(0.5);
    expect(roots.mdl.acceptMarginBits).toBe(4.0);
    expect(roots.mdl.minInstancesRaw).toBe(5);
    expect(roots.thresholds.eligibilityMinRawShare).toBeCloseTo(2 / 3);
    expect(roots.calib.targetPrecision).toBe(0.8);
    expect(roots.trend.cohortBy).toBe('birthYear');
    expect(roots.trend.nucleation).toEqual({ minSlopePerQuarter: 0.02, minWindows: 3, minHumanAuthors: 2 });
    expect(roots.cochange.maxPairs).toBe(5000);
    expect(roots.ledger.releaseStableDays).toBe(90);
    expect(roots.budgets.bashFloodThreshold).toBe(20);
    expect(roots.health.agentShareAlarm).toBe(0.85);
    expect(roots.completeness).toEqual({ mode: 'stop-feedback-once', maxItems: 5 });
    expect(roots.seed_tension).toEqual({ minFc: 1.5, minN: 10 });
    expect(roots.report).toEqual({ topFacts: 20 });
    expect(roots.hooks.claudeCode).toEqual({
      postTool: true, preTool: false, bash: true, userPromptBrief: false, stopCompleteness: true,
    });
    expect(roots.roles.clusterSampleCap).toBe(700);
    expect(roots.sessions).toEqual({ pruneDays: 7 });
  });

  it('a bare roots: key with nothing under it (YAML null) is rejected, matching coverage:/signals:/events: precedent — only roots: {} counts as "present and empty"', async () => {
    await expect(parseWith('roots:\n')).rejects.toThrow(/roots must be a mapping/);
  });
});

describe('roots config — partial overrides leave siblings at their defaults', () => {
  it('overriding one leaf of a section leaves the rest of that section, and every other section, default', async () => {
    const cfg = await parseWith('roots:\n  history:\n    windowMonths: 6\n');
    const roots = cfg.roots as RootsConfig;
    expect(roots.history.windowMonths).toBe(6);
    // Siblings within the same section stay default.
    expect(roots.history.full).toBe(true);
    expect(roots.history.maxCommits).toBe(0);
    // A section not mentioned at all stays fully default.
    expect(roots.weights.seedDefaultWeight).toBe(8);
  });

  it('overriding a deeply-nested leaf (enumerate.support.call) leaves its siblings default', async () => {
    const cfg = await parseWith('roots:\n  enumerate:\n    support:\n      call: 12\n');
    const roots = cfg.roots as RootsConfig;
    expect(roots.enumerate.support.call).toBe(12);
    expect(roots.enumerate.support.nodeType).toBe(20);
    expect(roots.enumerate.topK.call).toBe(80);
  });

  it('overriding a top-level string-array (include) replaces it wholesale', async () => {
    const cfg = await parseWith('roots:\n  include:\n    - "src/**"\n    - "lib/**"\n');
    const roots = cfg.roots as RootsConfig;
    expect(roots.include).toEqual(['src/**', 'lib/**']);
    expect(roots.exclude).toEqual([]);
  });
});

describe('roots config — unknown keys rejected at any depth', () => {
  it('an unknown key at the top level of roots: is a hard error naming the key', async () => {
    await expect(parseWith('roots:\n  bogus: true\n')).rejects.toThrow(ConfigParseError);
    await expect(parseWith('roots:\n  bogus: true\n')).rejects.toThrow(/unknown key 'bogus' under roots:/);
  });

  it('an unknown key nested two levels deep is a hard error naming the full dotted path', async () => {
    await expect(parseWith('roots:\n  history:\n    bogus: 1\n')).rejects.toThrow(
      /unknown key 'bogus' under roots\.history:/,
    );
  });

  it('an unknown key nested three levels deep (roots.enumerate.support) is caught too', async () => {
    await expect(parseWith('roots:\n  enumerate:\n    support:\n      bogus: 1\n')).rejects.toThrow(
      /unknown key 'bogus' under roots\.enumerate\.support:/,
    );
  });

  it('the ConfigParseError carries the established what/why/next shape and a config-roots-* code', async () => {
    try {
      await parseWith('roots:\n  bogus: true\n');
      expect.unreachable('parseWith should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigParseError);
      const err = e as ConfigParseError;
      expect(err.code).toBe('config-roots-unknown-key');
      expect(err.messageData.what).toMatch(/unknown key 'bogus' under roots:/);
      expect(err.messageData.why.length).toBeGreaterThan(0);
      expect(err.messageData.next.length).toBeGreaterThan(0);
    }
  });

  it('version and daemon — excluded from RootsConfig — are rejected the same as any other unknown key', async () => {
    await expect(parseWith('roots:\n  version: 1\n')).rejects.toThrow(/unknown key 'version' under roots:/);
    await expect(parseWith('roots:\n  daemon:\n    idleExitMinutes: 30\n')).rejects.toThrow(
      /unknown key 'daemon' under roots:/,
    );
  });
});

describe('roots config — type validation', () => {
  it('roots: itself must be a mapping', async () => {
    await expect(parseWith('roots: true\n')).rejects.toThrow(/roots must be a mapping/);
  });

  it('a string-array field given a non-array is rejected', async () => {
    await expect(parseWith('roots:\n  include: "not-a-list"\n')).rejects.toThrow(
      /roots\.include must be a list of strings/,
    );
  });

  it('a string-array field with a non-string element is rejected', async () => {
    await expect(parseWith('roots:\n  exclude:\n    - 1\n')).rejects.toThrow(
      /roots\.exclude must be a list of strings/,
    );
  });

  it('a numeric field given a string is rejected', async () => {
    await expect(parseWith('roots:\n  history:\n    windowMonths: "two years"\n')).rejects.toThrow(
      /roots\.history\.windowMonths must be a number/,
    );
  });

  it('a boolean field given a number is rejected', async () => {
    await expect(parseWith('roots:\n  history:\n    full: 1\n')).rejects.toThrow(
      /roots\.history\.full must be a boolean/,
    );
  });

  it('a string field given a number is rejected', async () => {
    await expect(parseWith('roots:\n  trend:\n    cohortBy: 5\n')).rejects.toThrow(
      /roots\.trend\.cohortBy must be a string/,
    );
  });

  it('a nested mapping field given a scalar is rejected', async () => {
    await expect(parseWith('roots:\n  partition: "auto"\n')).rejects.toThrow(
      /roots\.partition must be a mapping/,
    );
  });
});

describe('roots config — default isolation and overlay immunity', () => {
  it('two parses never share default sub-objects: mutating one cannot poison the next', async () => {
    const first = await parseWith('roots: {}\n');
    // Simulate a hostile/buggy consumer mutating its parsed config in place.
    first.roots!.history.agentIdentities.push('POISON');
    (first.roots!.mdl as { factCap: number }).factCap = -1;

    const second = await parseWith('roots: {}\n');
    expect(second.roots!.history.agentIdentities).not.toContain('POISON');
    expect(second.roots!.mdl.factCap).not.toBe(-1);
  });

  it('a gitignored yg-secrets.yaml overlay cannot wake the miner: roots is read from the committed file only', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yg-roots-overlay-'));
    dirsToCleanup.push(dir);
    const filePath = path.join(dir, 'yg-config.yaml');
    await writeFile(filePath, 'version: "5.2.0"\n', 'utf-8');
    await writeFile(path.join(dir, 'yg-secrets.yaml'), 'roots: {}\n', 'utf-8');

    const cfg = await parseConfig(filePath);
    expect(cfg.roots).toBeUndefined();
  });
});

describe('rootsConfigHash', () => {
  const BASE: RootsConfig = {
    include: ['**/*'],
    exclude: [],
    partition: { mode: 'auto' },
    history: {
      full: true, windowMonths: 24, maxCommits: 0, megaCommitFileCap: 30, churnEarlyDays: 14,
      blobMaxBytes: 1500000, lifecycleFileMaxKb: 300, lifecycleMaxAppearances: 200,
      agentIdentities: ['claude', 'copilot'],
    },
    enumerate: {
      support: { nodeType: 20, call: 8, import: 5, supertype: 4, shape: 15, decorator: 8 },
      topK: { nodeType: 30, call: 80, import: 60, supertype: 30, shape: 40, decorator: 40 },
      shapeDepth: 2, shapeMaxStatements: 20, pathSegments: 3, localVarSampleMax: 20,
    },
    weights: {
      survivalFullDays: 120, freshPenaltyDays: 14, agentBase: 0.15, agentPromoteDays: 180,
      baseFloor: 0.05, hookShapedWeight: 0.15, noLifecycleWeight: 0.3, dirtyWeight: 0.3,
      seedDefaultWeight: 8, seedCapFraction: 0.5,
    },
    mdl: { acceptMarginBits: 4.0, minInstancesRaw: 5, minInstancesEff: 3, factCap: 400, dedupJaccard: 0.9, dirContextMinScopes: 25 },
    thresholds: {
      preferenceGapBits: 2.5, absenceGapBits: 3.5, absenceGapBitsStructural: 4.5,
      eligibilityMinRawShare: 2 / 3, denyExtraBits: 1.5, denyMinPrecision: 0.9,
      roleAmbiguityGap: 0.15, roleMinMembership: 0.35, couplingPercentileForDeny: 75,
    },
    calib: { horizonDays: 365, settleDays: 30, minEventsConvention: 12, minEventsFamily: 30, minEventsDeny: 35, targetPrecision: 0.8 },
    trend: {
      windowDays: 90, windowCount: 8, maxWindows: 24, attractorSlopeK: 2.0, lowSampleMin: 8,
      cohortBy: 'birthYear', nucleation: { minSlopePerQuarter: 0.02, minWindows: 3, minHumanAuthors: 2 },
    },
    cochange: { minSupport: 8, minConfidence: 0.75, maxPairs: 5000 },
    ledger: { releaseStableDays: 90, releaseMinDaysAfterMark: 14 },
    budgets: {
      maxMessagesPerResponse: 3, sessionMaxWarnings: 12, hookHardTimeoutMs: 900, hookColdBudgetMs: 700,
      daemonBudgetMs: 50, bashSweepDebounceMs: 5000, bashSweepMaxFiles: 5, bashFloodThreshold: 20,
    },
    health: { minCompliance: 0.3, minSamples: 8, telemetryRetentionDays: 180, agentShareAlarm: 0.85 },
    completeness: { mode: 'stop-feedback-once', maxItems: 5 },
    seed_tension: { minFc: 1.5, minN: 10 },
    report: { topFacts: 20 },
    hooks: { claudeCode: { postTool: true, preTool: false, bash: true, userPromptBrief: false, stopCompleteness: true } },
    roles: { clusterSampleCap: 700, reinduceTouchedFraction: 0.05, reinduceTouchedMin: 200, minClusterSize: 3, minOwnFeatures: 2, cloneMedoidJaccard: 0.6 },
    sessions: { pruneDays: 7 },
  };

  it('is a 64-char hex sha256 digest', () => {
    const hash = rootsConfigHash(BASE);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across two calls with an identical config', () => {
    expect(rootsConfigHash(BASE)).toBe(rootsConfigHash(BASE));
  });

  it('is unaffected by the KEY ORDER the caller happened to build the object in', () => {
    // Same values, deliberately re-declared with a different property insertion
    // order (JS preserves insertion order; canonical-JSON sorts it away).
    const reordered: RootsConfig = {
      sessions: BASE.sessions,
      roles: BASE.roles,
      hooks: BASE.hooks,
      report: BASE.report,
      seed_tension: BASE.seed_tension,
      completeness: BASE.completeness,
      health: BASE.health,
      budgets: BASE.budgets,
      ledger: BASE.ledger,
      cochange: BASE.cochange,
      trend: BASE.trend,
      calib: BASE.calib,
      thresholds: BASE.thresholds,
      mdl: BASE.mdl,
      weights: BASE.weights,
      enumerate: BASE.enumerate,
      history: BASE.history,
      partition: BASE.partition,
      exclude: BASE.exclude,
      include: BASE.include,
    };
    expect(rootsConfigHash(reordered)).toBe(rootsConfigHash(BASE));
  });

  it('changes when any single leaf value changes', () => {
    const changed: RootsConfig = {
      ...BASE,
      weights: { ...BASE.weights, seedDefaultWeight: 9 },
    };
    expect(rootsConfigHash(changed)).not.toBe(rootsConfigHash(BASE));
  });

  it('changes when a deeply-nested leaf value changes', () => {
    const changed: RootsConfig = {
      ...BASE,
      trend: { ...BASE.trend, nucleation: { ...BASE.trend.nucleation, minWindows: 4 } },
    };
    expect(rootsConfigHash(changed)).not.toBe(rootsConfigHash(BASE));
  });

  it('the parser and the pure hash function agree: parseConfig-produced defaults hash reproducibly', async () => {
    const cfgA = await parseWith('roots: {}\n');
    const cfgB = await parseWith('roots: {}\n');
    const hashA = rootsConfigHash((cfgA.roots as RootsConfig));
    const hashB = rootsConfigHash((cfgB.roots as RootsConfig));
    expect(hashA).toBe(hashB);
  });
});
