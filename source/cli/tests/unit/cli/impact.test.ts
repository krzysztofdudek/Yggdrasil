import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Graph } from '../../../src/model/graph.js';
import { summarizeImpact, renderImpactTotal, collectInvalidatedPairs } from '../../../src/cli/impact-handlers.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import { readLock } from '../../../src/io/lock-store.js';
import { FIXTURE_TWO_COVERED_FILES } from '../../fixtures/type-level-engine/variants/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Build a minimal Graph with a reviewer config whose default tier has consensus=1.
 *  The graph has two aspects: 'c' (LLM) and 'd' (deterministic), and two nodes. */
function makeGraphWithReviewer(): Graph {
  return {
    config: {
      reviewer: {
        default: 'main',
        tiers: {
          main: {
            provider: 'anthropic',
            model: 'claude-3-5-haiku-20241022',
            temperature: 0,
            consensus: 1,
          },
        },
      },
    },
    architecture: { node_types: {} },
    nodes: new Map([
      ['scenarios', {
        path: 'scenarios',
        meta: { name: 'scenarios', type: 'module' },
        children: [],
        parent: null,
      }],
      ['specs', {
        path: 'specs',
        meta: { name: 'specs', type: 'module' },
        children: [],
        parent: null,
      }],
    ]),
    aspects: [
      {
        id: 'c',
        name: 'c',
        reviewer: { type: 'llm' },
        status: 'enforced',
      },
      {
        id: 'd',
        name: 'd',
        reviewer: { type: 'deterministic' },
        status: 'enforced',
      },
    ],
    flows: [],
    rootPath: '/fake/.yggdrasil',
  } as unknown as Graph;
}
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');
const TYPE_LEVEL_BASE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');

/**
 * The base type-level-engine fixture merged with its two-covered-files variant:
 * one real node (`owned`, type `leaf`) alongside two componentless files
 * (src/leaf/{a,b}.ts) matching the SAME type, which also carries llm-leaf-rule
 * and refuses-on-a. Used to prove computeExpectedPairs is threaded real
 * type-coverage classification at the `yg impact` call sites, not left
 * answering about a component-only universe.
 */
function mergedTypeLevelFixtureCopy(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ygg-impact-typelevel-'));
  cpSync(TYPE_LEVEL_BASE, dir, { recursive: true });
  cpSync(FIXTURE_TWO_COVERED_FILES, dir, { recursive: true });
  return dir;
}

async function withFixtureCopy<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ygg-impact-'));
  await cp(FIXTURE, root, { recursive: true });
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('impact command', () => {
  describe('--node', () => {
    it('shows directly dependent nodes', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'orders/order-service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('checkout/controller');
        expect(result.stdout).toContain('Directly dependent');
      });
    });

    it('shows flow membership', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'orders/order-service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Checkout Flow');
      });
    });

    it('shows event-connected nodes', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'orders/order-service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Event-connected');
        expect(result.stdout).toContain('users/user-repo');
      });
    });

    it('shows total scope summary', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'orders/order-service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Blast radius');
      });
    });

    it('shows aspects in scope', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'orders/order-service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Aspects');
      });
    });

    it('annotates effective status per aspect on Aspects line', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'orders/order-service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        // Aspects: <name> [enforced], ...
        expect(result.stdout).toMatch(/Aspects:.*\[enforced\]/);
      });
    });

    it('returns exit 1 for non-existent node', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'does/not/exist'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Node not found');
      });
    });

    it('handles node with no dependents gracefully', async () => {
      await withFixtureCopy(async (cwd) => {
        // checkout/controller uses orders/order-service but nothing uses checkout/controller
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'checkout/controller'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Directly dependent');
        expect(result.stdout).toContain('(none)');
      });
    });

    it('ends with a terminal Next: line after the Blast radius footer', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'orders/order-service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        // The blast-radius footer must precede the Next line; Next is the LAST
        // substantive line so the actionable step is never buried.
        const brIdx = result.stdout.indexOf('Blast radius:');
        const nextIdx = result.stdout.indexOf('Run yg context --node orders/order-service');
        expect(brIdx).toBeGreaterThan(-1);
        expect(nextIdx).toBeGreaterThan(brIdx);
        expect(result.stdout).toContain('yg context --node orders/order-service');
      });
    });
  });

  describe('--aspect', () => {
    it('shows directly affected nodes', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--aspect', 'requires-audit'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Directly affected');
        expect(result.stdout).toContain('orders');
        expect(result.stdout).toContain('orders/order-service');
      });
    });

    it('shows implies relationship', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--aspect', 'requires-audit'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Implies');
        expect(result.stdout).toContain('requires-logging');
      });
    });

    it('shows total scope', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--aspect', 'requires-audit'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Blast radius');
      });
    });

    it('ends with a terminal Next: line pointing at cost + yg check --approve', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--aspect', 'requires-audit'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
          'Next: weigh the cost above before editing the aspect, then run yg check --approve to re-verify the affected pairs.',
        );
      });
    });

    it('returns exit 1 for non-existent aspect', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--aspect', 'does-not-exist'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Aspect not found');
      });
    });

    it('shows [status] tag per affected (node, aspect) pair', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--aspect', 'requires-audit'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        // Each affected node line includes [<status>]; default is [enforced]
        expect(result.stdout).toMatch(/orders\/order-service \([^)]+\) \[enforced\]/);
      });
    });



    it('shows implied-by relationship for requires-logging', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--aspect', 'requires-logging'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Implied by');
        expect(result.stdout).toContain('requires-audit');
      });
    });
  });

  describe('--flow', () => {
    it('shows participants', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--flow', 'Checkout Flow'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Participants');
        expect(result.stdout).toContain('orders/order-service');
        expect(result.stdout).toContain('auth/auth-api');
      });
    });

    it('shows flow aspects', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--flow', 'Checkout Flow'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Flow aspects');
        expect(result.stdout).toContain('requires-logging');
      });
    });

    it('shows total scope', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--flow', 'Checkout Flow'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Blast radius');
      });
    });

    it('ends with a terminal Next: line for flow mode', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--flow', 'Checkout Flow'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
          'Next: review the participants above before editing the flow, then run yg check --approve to re-verify them.',
        );
      });
    });

    it('returns exit 1 for non-existent flow', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--flow', 'does-not-exist'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Flow not found');
      });
    });
  });

  describe('--file', () => {
    it('resolves file to owner node and shows impact', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--file', 'src/orders/order.service.ts'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        // stdout shows file->node resolution (informational, not error)
        // plus the impact output itself
        expect(result.stdout).toContain('src/orders/order.service.ts -> orders/order-service');
        expect(result.stdout).toContain('Impact of changes in orders/order-service');
        expect(result.stdout).toContain('checkout/controller');
      });
    });

    it('returns exit 1 for unmapped file', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--file', 'src/unmapped/file.ts'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('no graph coverage');
      });
    });

    it('classifies a --file outside the project root (what/why/next), not a generic crash', async () => {
      await withFixtureCopy(async (cwd) => {
        // An absolute path outside the repo copy resolves outside the project
        // root; the resolver throws "Path is outside project root", which impact
        // must classify as user input — never route to the "file an issue" abort.
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--file', '/etc/passwd'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('outside the project root');
        // The generic crash handler must NOT fire for this user-input error.
        expect(result.stderr).not.toContain('This is a bug');
      });
    });
  });

  describe('error cases', () => {
    it('requires at least one option', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync('node', [BIN_PATH, 'impact'], {
          cwd,
          encoding: 'utf-8',
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/--node|--aspect|--flow/);
      });
    });

    it('rejects --node and --file together', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'orders/order-service', '--file', 'src/orders/order.service.ts'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('mutually exclusive');
      });
    });

    it('rejects --node and --aspect together', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'orders/order-service', '--aspect', 'requires-audit'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Multiple targets specified');
      });
    });
  });

  describe('lock-seeded refused annotation', () => {
    /** Write a lock with one refused verdict for `requires-audit` on a node. */
    async function seedRefusedLock(cwd: string, unitKey: string): Promise<void> {
      const lock = {
        version: 1,
        verdicts: {
          'requires-audit': {
            [unitKey]: { verdict: 'refused', hash: 'staleish', reason: 'missing audit log call' },
          },
        },
        nodes: {},
      };
      // requires-audit is an LLM aspect, so its verdicts live in the committed
      // nondeterministic file that readLock actually merges (the legacy single
      // yg-lock.json is no longer read by the runtime).
      await writeFile(
        path.join(cwd, '.yggdrasil', 'yg-lock.nondeterministic.json'),
        JSON.stringify(lock, null, 2) + '\n',
        'utf-8',
      );
    }

    it('tags a node:<path> refused verdict with [refused] in --aspect output', async () => {
      await withFixtureCopy(async (cwd) => {
        await seedRefusedLock(cwd, 'node:orders/order-service');
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--aspect', 'requires-audit'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        // The affected line for the refused node carries the [refused] tag.
        expect(result.stdout).toMatch(/orders\/order-service \([^)]+\) \[enforced\] \[refused\]/);
      });
    });

    it('does not tag nodes that hold no refused verdict', async () => {
      await withFixtureCopy(async (cwd) => {
        await seedRefusedLock(cwd, 'node:orders/order-service');
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--aspect', 'requires-audit'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        // The parent `orders` node is affected but not refused → no [refused] tag.
        expect(result.stdout).toMatch(/^ {2}orders \([^)]+\) \[enforced\]$/m);
      });
    });

    it('exits 1 with a clear error when the lock is garbled', async () => {
      await withFixtureCopy(async (cwd) => {
        await writeFile(
          path.join(cwd, '.yggdrasil', 'yg-lock.nondeterministic.json'),
          '{ not json',
          'utf-8',
        );
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--aspect', 'requires-audit'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        // The error names the committed lock file that readLock actually reads
        // and found garbled (the LLM-verdict file under the 5.1.0 triad).
        expect(result.stderr).toMatch(/yg-lock\.nondeterministic\.json/);
      });
    });
  });

  describe('--type', () => {
    it('shows type info and nodes of that type', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--type', 'service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Type: service');
        expect(result.stdout).toContain('Nodes of this type (4):');
      });
    });

    it('shows source files covered', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--type', 'service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Source files covered');
      });
    });

    it('ends with a terminal Next: line for type mode', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--type', 'service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
          "Next: review the nodes of this type above before editing the type's defaults or when predicate, then run yg check --approve.",
        );
      });
    });

    it('returns exit 1 for non-existent type', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--type', 'does-not-exist'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Type 'does-not-exist' not found");
      });
    });

    it('rejects --type combined with --node', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--type', 'service', '--node', 'orders/order-service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Multiple targets specified');
      });
    });
  });

  describe('node-cost block', () => {
    it('--node prints the reviewer-call cost, not the old vague sentence', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--node', 'orders/order-service'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        // New cost block — substring-stable fragments.
        expect(result.stdout).toMatch(/reviewer call\(s\)/);
        expect(result.stdout).toContain('deterministic = free');
        expect(result.stdout).toMatch(/currently-green verdict\(s\) re-rolled/);
        expect(result.stdout).toContain('Editing this node re-verifies:');
        // The vague pre-cost sentence is gone (it had no number).
        expect(result.stdout).not.toContain(
          'Editing this node re-verifies its own pairs on the next yg check --approve',
        );
        // The terminal Next: line still ends the output (structured what/why/next format).
        expect(result.stdout).toContain('Run yg context --node orders/order-service');
      });
    });

    it('--file shows the unified Total to re-verify block', async () => {
      await withFixtureCopy(async (cwd) => {
        const result = spawnSync(
          'node',
          [BIN_PATH, 'impact', '--file', 'src/orders/order.service.ts'],
          { cwd, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('src/orders/order.service.ts -> orders/order-service');
        // New unified Total block replaces the old "Editing this file re-verifies:" line.
        expect(result.stdout).toContain('Total to re-verify:');
        expect(result.stdout).toMatch(/reviewer call\(s\)/);
        expect(result.stdout).toContain('deterministic pair(s)');
        // The old framing is gone.
        expect(result.stdout).not.toContain('Editing this file re-verifies:');
      });
    });
  });
});

describe('summarizeImpact + renderImpactTotal', () => {
  it('sums billed reviewer calls across llm pairs, counts free deterministic, groups by node', () => {
    const set = {
      pairs: [
        { aspectId: 'c', unitKey: 'file:a', nodePath: 'scenarios', kind: 'llm', reasons: ['observe-companion'], mode: 'precise' },
        { aspectId: 'd', unitKey: 'node:specs', nodePath: 'specs', kind: 'deterministic', reasons: ['own'], mode: 'precise' },
      ],
      unresolved: [],
    } as any;
    const graph = makeGraphWithReviewer();
    const lock = { version: 1, verdicts: {}, nodes: {} } as any;
    const s = summarizeImpact(set, graph, lock);
    expect(s.billedReviewerCalls).toBe(1);
    expect(s.freeDeterministic).toBe(1);
    expect(s.byNode.map((n) => n.nodePath).sort()).toEqual(['scenarios', 'specs']);
    const out = renderImpactTotal(s, 'apps/x/a.ts', { isTTY: false });
    expect(out).toContain('Total to re-verify:');
    expect(out).toContain('1 reviewer call(s)');
    expect(out).toContain('1 deterministic');
    expect(out).not.toContain('reviewer requests × consensus');
  });

  it('renders an Unresolved line when a companion failed', () => {
    const set = { pairs: [], unresolved: [{ aspectId: 'c', unitKey: 'file:a', nodePath: 'scenarios', why: 'boom' }] } as any;
    const s = summarizeImpact(set, makeGraphWithReviewer(), { version: 1, verdicts: {}, nodes: {} } as any);
    const out = renderImpactTotal(s, 'apps/x/a.ts', { isTTY: false });
    expect(out).toContain('Unresolved');
    expect(out).toContain('scenarios');
  });
});

// ===========================================================================
// Type-level coverage threading — `yg impact --aspect` and `--file` must count
// the SAME expected-pair universe `yg check` counts, including a file enforced
// by its architecture type alone (no owning component). Real fixture, real
// binary / real function call — no fabricated pair data.
// ===========================================================================

describe('yg impact — type-level coverage threading', () => {
  it('--aspect counts a componentless file-level pair sharing the aspect-holding type, not just the one node that also has it', () => {
    const dir = mergedTypeLevelFixtureCopy();
    try {
      const result = spawnSync('node', [BIN_PATH, 'impact', '--aspect', 'llm-leaf-rule'], { cwd: dir, encoding: 'utf-8' });
      expect(result.status).toBe(0);
      // llm-leaf-rule is attached to type `leaf`. `owned` (a real node of that
      // type) contributes its own one pair; src/leaf/a.ts and src/leaf/b.ts
      // (componentless, matched by the same type) contribute one pair each —
      // 3 total, not 1. Without threading, computeAspectFillCost would only
      // ever see the 1 node-owned pair.
      expect(result.stdout).toContain('(3 pair(s))');
      expect(result.stdout).toContain('3 reviewer call(s)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--file (collectInvalidatedPairs) admits a componentless file-level pair by "own" reason, with no owning node', async () => {
    const dir = mergedTypeLevelFixtureCopy();
    try {
      const graph = await loadGraph(dir);
      const lock = readLock(graph.rootPath);
      const set = await collectInvalidatedPairs(graph, 'src/leaf/a.ts', lock, dir);
      const own = set.pairs.filter((p) => p.reasons.includes('own'));
      const ownAspectIds = own.map((p) => p.aspectId);
      // The two-covered-files variant's own aspects (the deterministic
      // refuses-on-a and the LLM llm-leaf-rule) are among the file-level pairs
      // admitted for src/leaf/a.ts, alongside the base fixture's own leaf-type
      // attachments (own-file-rule etc.) — none of them have an owning node.
      expect(ownAspectIds).toContain('llm-leaf-rule');
      expect(ownAspectIds).toContain('refuses-on-a');
      expect(own.every((p) => p.nodePath === undefined)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
