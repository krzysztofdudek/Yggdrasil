// =============================================================================
// CLI E2E — the cost the `next:` step states is the cost of running it.
//
// `yg check` names one step first and says what it costs. When that step is a
// fill, the cost is the whole command's: every pending pair it fills, advisory
// ones included, and the reviewer's share as pairs AND calls (a tier's
// consensus multiplies what each pair bills). The fill's own cost preview is
// the other witness of the same number, so on three trees — script rules only,
// script and reviewer rules mixed, and advisory rules only — the machine
// document's `next.cost` must equal the `dryRunBudget` of running that very
// step with `--dry-run`, and the whole `yg check --approve` preview must equal
// what the step and the paid step after it state together.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGitFixture } from '../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(__dirname, '../..', 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  for (const k of ['FORCE_COLOR', 'CI', 'GITHUB_ACTIONS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete e[k];
  return e;
}

const run = (dir: string, args: string[]) => {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd: dir, encoding: 'utf-8', timeout: 90_000, env: env() });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

// Consensus 3: a reviewer pair bills three calls, so pairs and calls differ.
const REVIEWER = `reviewer:
  tiers:
    standard:
      provider: ollama
      consensus: 3
      config:
        model: test
        endpoint: http://127.0.0.1:1
`;

interface Rule { id: string; kind: 'script' | 'reviewer'; status: 'enforced' | 'advisory' }

/** Two services under one module; every rule attached to both through the service type. */
function project(rules: Rule[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-next-cost-'));
  try {
    runGitFixture(dir, ['init', '-q', '-b', 'main']);
    const w = (rel: string, content: string) => {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), content);
    };
    w('.yggdrasil/yg-config.yaml', `version: "6.0.0"\ncoverage:\n  required:\n    - src/\n  excluded: []\n${REVIEWER}`);
    w('.yggdrasil/yg-architecture.yaml', `node_types:\n  module:\n    description: 'A module.'\n  service:\n    description: 'A service.'\n    when:\n      path: "src/svc-*/**"\n    parents: [module]\n    aspects:\n${rules.map((r) => `      - ${r.id}`).join('\n')}\n`);
    for (const r of rules) {
      const status = r.status === 'advisory' ? 'status: advisory\n' : '';
      w(`.yggdrasil/aspects/${r.id}/yg-aspect.yaml`, `name: ${r.id}\ndescription: Rule ${r.id}.\n${status}reviewer:\n  type: ${r.kind === 'script' ? 'deterministic' : 'llm'}\n`);
      if (r.kind === 'script') w(`.yggdrasil/aspects/${r.id}/check.mjs`, 'export function check(ctx) { return ctx.files.length < 0 ? [] : []; }\n');
      else w(`.yggdrasil/aspects/${r.id}/content.md`, `Every exported name follows ${r.id}.\n`);
    }
    w('.yggdrasil/model/app/yg-node.yaml', 'name: App\ntype: module\ndescription: "The app."\n');
    for (const id of ['svc-01', 'svc-02']) {
      w(`.yggdrasil/model/app/${id}/yg-node.yaml`, `name: ${id}\ntype: service\ndescription: "Service ${id}."\nmapping:\n  - src/${id}/\n`);
      w(`src/${id}/index.ts`, 'export const value = 1;\n');
    }
    const init = run(dir, ['init', '--upgrade']);
    if (init.status !== 0) throw new Error(`init --upgrade failed: ${init.stdout}${init.stderr}`);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return dir;
}

interface Cost { free: number; reviewerPairs: number; reviewerCalls: number }
interface Next { command: string[] | null; cost: Cost; then: string | null }
interface Budget { pairs: number; deterministic: number; reviewerCalls: number }

function nextOf(dir: string): Next {
  const out = run(dir, ['check', '--json']);
  return (JSON.parse(out.stdout) as { next: Next }).next;
}

/** The preview of running `args` (a `yg check --approve…` command, without the `yg`) as numbers. */
function budgetOf(dir: string, args: string[]): Budget {
  const out = run(dir, [...args, '--dry-run', '--json']);
  expect(out.status).toBe(0);
  return (JSON.parse(out.stdout) as { dryRunBudget: Budget }).dryRunBudget;
}

const asCost = (b: Budget): Cost => ({ free: b.deterministic, reviewerPairs: b.pairs - b.deterministic, reviewerCalls: b.reviewerCalls });

/** The reviewer pairs and calls a `then: yg check --approve  (…)` step states. */
function thenCost(then: string): { reviewerPairs: number; reviewerCalls: number } {
  const m = /(\d+) reviewer pairs? · (\d+) calls? · paid/.exec(then);
  expect(m, then).not.toBeNull();
  return { reviewerPairs: Number(m![1]), reviewerCalls: Number(m![2]) };
}

function expectParity(dir: string): Next {
  const next = nextOf(dir);
  expect(next).not.toBeNull();
  expect(next.command).not.toBeNull();
  expect(next.command!.slice(0, 3)).toEqual(['yg', 'check', '--approve']);
  // The step's own cost is the preview of running exactly that step.
  expect(next.cost).toEqual(asCost(budgetOf(dir, next.command!.slice(1))));
  // And the whole fill costs what the step and the paid step after it state together.
  const whole = asCost(budgetOf(dir, ['check', '--approve']));
  if (next.command!.includes('--only-deterministic') && next.then !== null) {
    expect({ free: next.cost.free, ...thenCost(next.then) }).toEqual(whole);
  } else {
    expect(next.cost).toEqual(whole);
  }
  return next;
}

describe.skipIf(!distExists)('CLI E2E — next.cost is the cost of the command next names', () => {
  it('script rules only: the free lane, every pending script pair, no reviewer calls', () => {
    const dir = project([{ id: 'no-todo', kind: 'script', status: 'enforced' }, { id: 'no-print', kind: 'script', status: 'advisory' }]);
    try {
      const next = expectParity(dir);
      expect(next.command).toEqual(['yg', 'check', '--approve', '--only-deterministic']);
      // The advisory rule's pairs are filled too, so they are in the cost.
      expect(next.cost).toEqual({ free: 4, reviewerPairs: 0, reviewerCalls: 0 });
      expect(next.then).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('mixed: the paid fill states every pair it fills — advisory ones and script ones too — as pairs and calls', () => {
    const dir = project([
      { id: 'readable-names', kind: 'reviewer', status: 'enforced' },
      { id: 'clear-docs', kind: 'reviewer', status: 'advisory' },
      { id: 'no-print', kind: 'script', status: 'advisory' },
    ]);
    try {
      const next = expectParity(dir);
      expect(next.command).toEqual(['yg', 'check', '--approve']);
      expect(next.cost).toEqual({ free: 2, reviewerPairs: 4, reviewerCalls: 12 });
      const text = run(dir, ['check']).stdout;
      expect(text).toContain('next: yg check --approve  (2 script pairs · free + 4 reviewer pairs · 12 calls · paid — ask the user to approve it first)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('mixed with only script pairs blocking: the free lane first, then the paid run for the advisory reviewer pairs, with their calls', () => {
    const dir = project([
      { id: 'no-todo', kind: 'script', status: 'enforced' },
      { id: 'clear-docs', kind: 'reviewer', status: 'advisory' },
    ]);
    try {
      const next = expectParity(dir);
      expect(next.command).toEqual(['yg', 'check', '--approve', '--only-deterministic']);
      expect(next.cost).toEqual({ free: 2, reviewerPairs: 0, reviewerCalls: 0 });
      expect(next.then).toBe('yg check --approve  (2 reviewer pairs · 6 calls · paid — ask the user to approve it first)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('advisory rules only: nothing blocks, and the step still states what the fill it names bills', () => {
    const dir = project([{ id: 'clear-docs', kind: 'reviewer', status: 'advisory' }, { id: 'no-print', kind: 'script', status: 'advisory' }]);
    try {
      const out = run(dir, ['check', '--json']);
      expect(out.status).toBe(0);
      const next = expectParity(dir);
      expect(next.cost.free + next.cost.reviewerPairs).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
