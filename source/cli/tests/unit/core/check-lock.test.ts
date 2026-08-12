/**
 * runCheck-level tests for the verdict-lock live path (spec §6).
 *
 * These wire a fixture graph + on-disk lock through the NEW pipeline and assert
 * the emitted issue CODES and SEVERITIES. They live beside the legacy check
 * tests without modifying them (the old drift tests fail once B4 deletes their
 * subjects — left for B8).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Graph, GraphNode, AspectDef, LlmConfig, AspectStatus } from '../../../src/model/graph.js';
import type { LockFile } from '../../../src/model/lock.js';
import { nodeUnit, LOCK_FORMAT_VERSION } from '../../../src/model/lock.js';
import { runCheck } from '../../../src/core/check.js';
import type { CheckIssue } from '../../../src/core/check.js';
import type { BurnSet } from '../../../src/core/progressive-scope.js';
import { writeLock } from '../../../src/io/lock-store.js';
import { writeSeededLock } from '../helpers/seed-lock.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'yg-check-lock-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const TIER: LlmConfig = { provider: 'ollama', model: 'test', temperature: 0, consensus: 1 };

function writeFile(relPath: string, content: string): void {
  const abs = path.join(tmpDir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function buildGraph(
  aspectStatus: AspectStatus,
  ruleContent = 'rule',
  tier: LlmConfig = TIER,
): Graph {
  const rootPath = path.join(tmpDir, '.yggdrasil');
  mkdirSync(rootPath, { recursive: true });
  const aspect: AspectDef = {
    id: 'asp', name: 'asp', reviewer: { type: 'llm' }, status: aspectStatus,
    artifacts: [{ filename: 'content.md', content: ruleContent }],
  } as AspectDef;
  const node: GraphNode = {
    path: 'svc',
    meta: { name: 'svc', type: 'service', aspects: ['asp'], mapping: ['src/a.ts'] },
    children: [], parent: null,
  } as GraphNode;
  return {
    config: { version: '5.0.0', reviewer: { tiers: { default: tier }, default: 'default' } },
    architecture: { node_types: { service: { description: 'test' } } },
    nodes: new Map([['svc', node]]),
    aspects: [aspect],
    flows: [], schemas: [], rootPath,
  } as unknown as Graph;
}

/**
 * Write the subject file, seed a valid verdict entry for asp/node:svc through the
 * shared seed-lock helper (real frozen-contract fold), then run the check.
 * `verdict: null` writes an EMPTY lock (the unverified / prompt-too-large cases).
 */
async function seedAndCheck(
  graph: Graph,
  verdict: { verdict: 'approved' | 'refused'; reason?: string } | null,
) {
  writeFile('src/a.ts', 'code');
  if (verdict === null) {
    const lock: LockFile = { version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {} };
    const deterministicAspectIds = new Set(
      graph.aspects.filter((a) => a.reviewer.type === 'deterministic').map((a) => a.id),
    );
    await writeLock(graph.rootPath, lock, { scope: 'all', deterministicAspectIds });
  } else {
    await writeSeededLock(graph, {
      verdicts: [{ aspectId: 'asp', unitKey: nodeUnit('svc'), verdict: verdict.verdict, reason: verdict.reason }],
    });
  }
  return runCheck(graph, null); // null git files → skip coverage
}

describe('runCheck — verdict-lock issue emission', () => {
  it('missing entry on enforced aspect → unverified error', async () => {
    const graph = buildGraph('enforced');
    const result = await seedAndCheck(graph, null);
    const issue = result.issues.find((i) => i.code === 'unverified');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(result.suggestedNext).toBe('yg check --approve');
  });

  it('missing entry on advisory aspect → unverified WARNING (never blocks)', async () => {
    const graph = buildGraph('advisory');
    const result = await seedAndCheck(graph, null);
    const issue = result.issues.find((i) => i.code === 'unverified');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
    // The advisory unverified must NOT be promoted to an error (only an enforced
    // unverified blocks). Other structural validator codes from this minimal
    // fixture are out of scope here — we assert the lock pair's severity only.
    const lockErrors = result.issues.filter(
      (i) => i.severity === 'error' && (i.code === 'unverified' || i.code === 'aspect-violation-enforced'),
    );
    expect(lockErrors).toHaveLength(0);
  });

  it('valid approved entry → no issue', async () => {
    const graph = buildGraph('enforced');
    const result = await seedAndCheck(graph, { verdict: 'approved' });
    expect(result.issues.some((i) => i.code === 'unverified' || i.code === 'aspect-violation-enforced')).toBe(false);
  });

  it('valid refused entry on enforced aspect → aspect-violation-enforced error with cached marker', async () => {
    const graph = buildGraph('enforced');
    const result = await seedAndCheck(graph, { verdict: 'refused', reason: 'broke the rule' });
    const issue = result.issues.find((i) => i.code === 'aspect-violation-enforced');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(issue!.messageData.what).toContain('cached verdict — the reviewer did NOT re-run');
  });

  it('valid refused entry on advisory aspect → aspect-violation-advisory warning', async () => {
    const graph = buildGraph('advisory');
    const result = await seedAndCheck(graph, { verdict: 'refused', reason: 'broke the rule' });
    const issue = result.issues.find((i) => i.code === 'aspect-violation-advisory');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
    expect(result.advisoryWarnings).toBe(1);
    // An advisory refusal never produces a lock error (it is a warning).
    const lockErrors = result.issues.filter(
      (i) => i.severity === 'error' && (i.code === 'aspect-violation-enforced' || i.code === 'unverified'),
    );
    expect(lockErrors).toHaveLength(0);
  });

  it('prompt-too-large → error, takes precedence over unverified (no duplicate)', async () => {
    const tier: LlmConfig = { ...TIER, max_prompt_chars: 30 };
    const graph = buildGraph('enforced', 'a long rule that overflows the tiny char limit', tier);
    const result = await seedAndCheck(graph, null); // no entry
    expect(result.issues.filter((i) => i.code === 'prompt-too-large')).toHaveLength(1);
    expect(result.issues.some((i) => i.code === 'unverified')).toBe(false);
    expect(result.issues.find((i) => i.code === 'prompt-too-large')!.severity).toBe('error');
  });

  it('garbled lock → single lock-invalid error, fail closed (no pair issues)', async () => {
    writeFile('src/a.ts', 'code');
    const graph = buildGraph('enforced');
    mkdirSync(graph.rootPath, { recursive: true });
    // Write the garbled content to a committed file readLock actually reads (the
    // nondeterministic LLM-verdict file); the legacy single yg-lock.json is no
    // longer read by the runtime under the 5.1.0 triad.
    writeFileSync(path.join(graph.rootPath, 'yg-lock.nondeterministic.json'), '{ not valid json', 'utf-8');
    const result = await runCheck(graph, null);
    expect(result.issues.filter((i) => i.code === 'lock-invalid')).toHaveLength(1);
    expect(result.issues.some((i) => i.code === 'unverified')).toBe(false);
    expect(result.suggestedNext).toContain('git checkout');
  });
});

// ── Deterministic refusal rendering + log integrity / format branches ─────────

/** A graph with a single deterministic aspect on node `svc`. */
function buildDetGraph(status: AspectStatus, checkContent = 'export function check(){return [];}\n'): Graph {
  const rootPath = path.join(tmpDir, '.yggdrasil');
  mkdirSync(rootPath, { recursive: true });
  const aspect = {
    id: 'det', name: 'det', reviewer: { type: 'deterministic' }, status,
    artifacts: [{ filename: 'check.mjs', content: checkContent }],
  } as unknown as AspectDef;
  const node = {
    path: 'svc',
    meta: { name: 'svc', type: 'service', aspects: ['det'], mapping: ['src/a.ts'] },
    children: [], parent: null,
  } as GraphNode;
  return {
    config: { version: '5.0.0', reviewer: { tiers: { default: TIER }, default: 'default' } },
    architecture: { node_types: { service: { description: 'test', log_required: true } } },
    nodes: new Map([['svc', node]]),
    aspects: [aspect],
    flows: [], schemas: [], rootPath,
  } as unknown as Graph;
}

describe('runCheck — deterministic refusal + log integrity/format', () => {
  it('a valid REFUSED deterministic entry renders aspect-violation-enforced with the det message', async () => {
    writeFile('src/a.ts', 'code');
    const graph = buildDetGraph('enforced');
    await writeSeededLock(graph, {
      verdicts: [{ aspectId: 'det', unitKey: nodeUnit('svc'), verdict: 'refused', reason: 'src/a.ts:1: bad thing' }],
    });
    const result = await runCheck(graph, null);
    const issue = result.issues.find((i) => i.code === 'aspect-violation-enforced');
    expect(issue).toBeDefined();
    // The deterministic message (not the LLM cached-verdict marker) renders.
    expect(issue!.messageData.what).toContain('by a deterministic check');
    expect(issue!.messageData.what).toContain('src/a.ts:1: bad thing');
  });

  it('a tampered log (prefix_modified) → log-integrity error', async () => {
    writeFile('src/a.ts', 'code');
    // A well-formed log whose baseline we seed, then mutate the historical content.
    writeFile('.yggdrasil/model/svc/log.md', '## [2026-05-11T10:00:00.000Z]\noriginal reason.\n');
    const graph = buildDetGraph('enforced');
    await writeSeededLock(graph, {
      verdicts: [{ aspectId: 'det', unitKey: nodeUnit('svc'), verdict: 'approved' }],
      nodes: { svc: { log: true, source: true } },
    });
    // Now rewrite the historical (pre-baseline) entry → prefix hash no longer matches.
    writeFile('.yggdrasil/model/svc/log.md', '## [2026-05-11T10:00:00.000Z]\nTAMPERED reason.\n');
    const result = await runCheck(graph, null);
    const issue = result.issues.find((i) => i.code === 'log-integrity');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    // The recovery `next` must name the committed log baseline (the triad
    // member), NOT the retired single-file `yg-lock.json`.
    expect(issue!.messageData.next).toContain('.yggdrasil/yg-lock.logs.json');
    // No bare `yg-lock.json` token (the negative lookahead lets `.logs.json`
    // through but catches `yg-lock.json` standing alone).
    expect(issue!.messageData.next).not.toMatch(/yg-lock\.json(?![\w.])/);
    // Still points at the node's log.md to restore.
    expect(issue!.messageData.next).toContain(`.yggdrasil/model/svc/log.md`);
    // The :610 log-integrity suggestedNext branch fires for this error and must
    // likewise name the committed log baseline, not the zombie name.
    expect(result.suggestedNext).not.toBeNull();
    expect(result.suggestedNext!).toContain('.yggdrasil/yg-lock.logs.json');
    expect(result.suggestedNext!).not.toMatch(/yg-lock\.json(?![\w.])/);
  });

  it('a malformed log (bad format) → log-format error', async () => {
    writeFile('src/a.ts', 'code');
    // No baseline in the lock → integrity check is skipped, but the format
    // validator still runs and flags the malformed entry header.
    writeFile('.yggdrasil/model/svc/log.md', 'this is not a valid log entry header\n');
    const graph = buildDetGraph('enforced');
    await writeSeededLock(graph, {
      verdicts: [{ aspectId: 'det', unitKey: nodeUnit('svc'), verdict: 'approved' }],
    });
    const result = await runCheck(graph, null);
    expect(result.issues.some((i) => i.code === 'log-format')).toBe(true);
  });
});

// ── Git conflict markers in log.md → log-conflict (route to merge-resolve) ───

/** A log.md carrying git conflict markers (open/close + a separator). */
const CONFLICTED_LOG =
  '## [2026-05-11T10:00:00.000Z]\n' +
  '<<<<<<< HEAD\n' +
  'ours reason.\n' +
  '=======\n' +
  'theirs reason.\n' +
  '>>>>>>> branch\n';

describe('runCheck — git conflict markers in log.md', () => {
  it('conflict-markered log (no baseline) → log-conflict, NOT log-format', async () => {
    writeFile('src/a.ts', 'code');
    // No baseline seeded — the conflict check fires before integrity AND before
    // the format validator would otherwise flag the marker lines as bad headers.
    writeFile('.yggdrasil/model/svc/log.md', CONFLICTED_LOG);
    const graph = buildDetGraph('enforced');
    await writeSeededLock(graph, {
      verdicts: [{ aspectId: 'det', unitKey: nodeUnit('svc'), verdict: 'approved' }],
    });
    const result = await runCheck(graph, null);
    const issue = result.issues.find((i) => i.code === 'log-conflict');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    // The conflict check short-circuits — no log-format issue for the same node.
    expect(result.issues.some((i) => i.code === 'log-format')).toBe(false);
    expect(issue!.messageData.next).toBe('yg log merge-resolve --node svc');
    expect(issue!.messageData.what).toContain('.yggdrasil/model/svc/log.md');
  });

  it('baseline present + markers → log-conflict, NOT log-integrity', async () => {
    writeFile('src/a.ts', 'code');
    // Seed a clean baseline first, then overwrite with a conflict-markered body.
    writeFile('.yggdrasil/model/svc/log.md', '## [2026-05-11T10:00:00.000Z]\noriginal reason.\n');
    const graph = buildDetGraph('enforced');
    await writeSeededLock(graph, {
      verdicts: [{ aspectId: 'det', unitKey: nodeUnit('svc'), verdict: 'approved' }],
      nodes: { svc: { log: true, source: true } },
    });
    writeFile('.yggdrasil/model/svc/log.md', CONFLICTED_LOG);
    const result = await runCheck(graph, null);
    const issue = result.issues.find((i) => i.code === 'log-conflict');
    expect(issue).toBeDefined();
    // The conflict check runs BEFORE the integrity branch — no log-integrity issue.
    expect(result.issues.some((i) => i.code === 'log-integrity')).toBe(false);
  });

  it('suggestedNext routes to merge-resolve (not fix-format / restore-from-git)', async () => {
    writeFile('src/a.ts', 'code');
    writeFile('.yggdrasil/model/svc/log.md', CONFLICTED_LOG);
    const graph = buildDetGraph('enforced');
    await writeSeededLock(graph, {
      verdicts: [{ aspectId: 'det', unitKey: nodeUnit('svc'), verdict: 'approved' }],
    });
    const result = await runCheck(graph, null);
    expect(result.suggestedNext).toBe('yg log merge-resolve --node svc');
  });

  it('setext H1 underline (bare =======) under a heading does NOT false-positive', async () => {
    writeFile('src/a.ts', 'code');
    // A well-formed log entry whose body uses a markdown setext H1 underline
    // (a run of `=` on its own line) — this is NOT a git conflict separator.
    // The open/close-only regex must NOT treat it as a conflict.
    writeFile(
      '.yggdrasil/model/svc/log.md',
      '## [2026-05-11T10:00:00.000Z]\n' +
        '### A heading\n' +
        'some prose.\n' +
        '\n' +
        'A setext title\n' +
        '=======\n' +
        'more prose.\n',
    );
    const graph = buildDetGraph('enforced');
    await writeSeededLock(graph, {
      verdicts: [{ aspectId: 'det', unitKey: nodeUnit('svc'), verdict: 'approved' }],
    });
    const result = await runCheck(graph, null);
    expect(result.issues.some((i) => i.code === 'log-conflict')).toBe(false);
  });
});

// ── Regression guard: every lock path named in a recovery string is git-tracked ─

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/unit/core → repo root is five levels up (core → unit → tests → cli → source → root).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

/** All `.yggdrasil/...yg-lock....json` tokens mentioned in a recovery string. */
function extractLockTokens(text: string): string[] {
  return text.match(/\.yggdrasil\/[\w./-]*yg-lock[\w.-]*\.json/g) ?? [];
}

describe('runCheck — recovery strings only name git-tracked lock files', () => {
  it('every lock path in a log-recovery next string resolves to a git-tracked file', async () => {
    // Drive runCheck to a log-integrity issue (tampered pre-baseline content).
    writeFile('src/a.ts', 'code');
    writeFile('.yggdrasil/model/svc/log.md', '## [2026-05-11T10:00:00.000Z]\noriginal reason.\n');
    const graph = buildDetGraph('enforced');
    await writeSeededLock(graph, {
      verdicts: [{ aspectId: 'det', unitKey: nodeUnit('svc'), verdict: 'approved' }],
      nodes: { svc: { log: true, source: true } },
    });
    writeFile('.yggdrasil/model/svc/log.md', '## [2026-05-11T10:00:00.000Z]\nTAMPERED reason.\n');
    const result = await runCheck(graph, null);

    // Collect every recovery string the agent could be steered to: the
    // top-level suggestedNext plus each log-integrity/log-format issue's `next`.
    const recoveryStrings: string[] = [];
    if (result.suggestedNext) recoveryStrings.push(result.suggestedNext);
    for (const issue of result.issues) {
      if (issue.code === 'log-integrity' || issue.code === 'log-format') {
        recoveryStrings.push(issue.messageData.next);
      }
    }

    const tokens = recoveryStrings.flatMap(extractLockTokens);
    // The fixture above guarantees at least the log-integrity branch fired, so a
    // lock path is present. A zero count would mean the recovery strings stopped
    // naming the lock — itself a regression worth failing on.
    expect(tokens.length).toBeGreaterThanOrEqual(1);

    // Every named lock path must be a real, git-tracked file. A reintroduced bare
    // `.yggdrasil/yg-lock.json` (the retired single-file name) is NOT tracked and
    // would make `git ls-files` return empty here.
    for (const token of tokens) {
      let tracked: string;
      try {
        tracked = execFileSync('git', ['ls-files', token], {
          cwd: REPO_ROOT,
          encoding: 'utf-8',
        });
      } catch (err) {
        throw new Error(
          `Could not run \`git ls-files ${token}\` (is git available in PATH?): ${String(err)}`,
          { cause: err },
        );
      }
      expect(
        tracked.trim().length,
        `recovery string names untracked lock file: ${token}`,
      ).toBeGreaterThan(0);
    }
  });
});

// ── Verified-pair tally split (deterministic vs LLM) ──────────────────────────

/** A graph with node `svc` carrying both an LLM aspect and a deterministic aspect. */
function buildMixedGraph(): Graph {
  const rootPath = path.join(tmpDir, '.yggdrasil');
  mkdirSync(rootPath, { recursive: true });
  const llmAspect: AspectDef = {
    id: 'llm-asp', name: 'llm-asp', reviewer: { type: 'llm' }, status: 'enforced',
    artifacts: [{ filename: 'content.md', content: 'rule' }],
  } as AspectDef;
  const detAspect = {
    id: 'det-asp', name: 'det-asp', reviewer: { type: 'deterministic' }, status: 'enforced',
    artifacts: [{ filename: 'check.mjs', content: 'export function check(){return [];}\n' }],
  } as unknown as AspectDef;
  const node: GraphNode = {
    path: 'svc',
    meta: { name: 'svc', type: 'service', aspects: ['llm-asp', 'det-asp'], mapping: ['src/a.ts'] },
    children: [], parent: null,
  } as GraphNode;
  return {
    config: { version: '5.0.0', reviewer: { tiers: { default: TIER }, default: 'default' } },
    architecture: { node_types: { service: { description: 'test' } } },
    nodes: new Map([['svc', node]]),
    aspects: [llmAspect, detAspect],
    flows: [], schemas: [], rootPath,
  } as unknown as Graph;
}

describe('runCheck — verified pair tally split (deterministic vs LLM)', () => {
  it('verifiedDet + verifiedLlm sum to the total verified pairs, split by reviewer kind', async () => {
    writeFile('src/a.ts', 'code');
    const graph = buildMixedGraph();
    await writeSeededLock(graph, {
      verdicts: [
        { aspectId: 'llm-asp', unitKey: nodeUnit('svc'), verdict: 'approved' },
        { aspectId: 'det-asp', unitKey: nodeUnit('svc'), verdict: 'approved' },
      ],
    });
    const result = await runCheck(graph, null);
    expect(result.verifiedLlm).toBe(1);
    expect(result.verifiedDet).toBe(1);
    expect(result.verifiedDet + result.verifiedLlm).toBe(2);
  });
});

// ── Change scope: accepted, threaded, and provably inert ──────────────────────

describe('runCheck — change scope is accepted and changes nothing', () => {
  it('a populated change scope yields a result identical to omitting the option', async () => {
    writeFile('src/a.ts', 'code');
    const graph = buildGraph('enforced');
    const lock: LockFile = { version: LOCK_FORMAT_VERSION, verdicts: {}, nodes: {} };
    await writeLock(graph.rootPath, lock, { scope: 'all', deterministicAspectIds: new Set<string>() });

    // The narrowest honest scope there is: a real reference, and nothing at all
    // burned by the change. It is chosen precisely because it is the value a
    // consumer would act on most visibly — every issue below is outside it — so
    // if ANY code read this option, the two results could not match.
    const burn: BurnSet = {
      global: false,
      pairKeys: new Set(),
      nodePaths: new Set(),
      files: new Set(),
      logOnlyNodePaths: new Set(),
      changedInputCount: 0,
    };

    const withoutOption = await runCheck(graph, null);
    const withOption = await runCheck(graph, null, { changeScope: { burn, referenceName: 'origin/main' } });

    // Guard against a vacuous pass: there IS something here that a scope could
    // have re-coded or dropped.
    expect(withoutOption.issues.length).toBeGreaterThan(0);
    expect(withOption).toEqual(withoutOption);

    // …and the result fields a later consumer will populate stay unset, so no
    // report can start rendering a scope that nothing computed.
    expect(withOption.outsideCount).toBeUndefined();
    expect(withOption.progressiveReference).toBeUndefined();
    expect(withOption.changedInputCount).toBeUndefined();
  });

  it('an issue can carry flow and edge identity', () => {
    // Type-level smoke for the two identity fields added alongside the option:
    // a flow issue has no nodePath to be matched by, and an edge-derived issue
    // has no single subject file, so both need somewhere structured to say what
    // they are about. Nothing populates them yet.
    const issue: CheckIssue = {
      code: 'description-missing',
      severity: 'warning',
      rule: 'description-required',
      messageData: { what: 'flow lacks a description', why: 'readers cannot tell what it does', next: 'add one' },
      flowName: 'checkout',
      relationEdges: [{ fromFile: 'src/a.ts', toFile: 'src/b.ts' }],
    };
    expect(issue.flowName).toBe('checkout');
    expect(issue.relationEdges).toEqual([{ fromFile: 'src/a.ts', toFile: 'src/b.ts' }]);
  });
});
