// =============================================================================
// `yg drill` end-to-end over the PUBLIC CLI surface (spawned bin.js). Covers:
//   (1) the deterministic path — a real check.mjs over a violates/satisfies
//       corpus → pass/pass, exit 0, footer, and the HONESTY FRAME (no case source
//       in the output);
//   (2) the LLM path — the production prompt path against the in-process mock
//       reviewer → pass/pass, exit 0, the budget line BEFORE the first case
//       result, one source:'drill' verdict-event per LLM case, and matching
//       .drill-results.jsonl lines; the lock is NEVER written;
//   (3) prompt-too-large → unrun, exit 2, reviewer never called;
//   (4) the shipped in-repo deterministic corpus (wasm-tree-lifecycle) → all pass.
//
// HERMETIC: a fresh mkdtemp copy of e2e-lifecycle per test, mutated in place,
// rmSync'd in finally. Ephemeral loopback port for the mock, no fixed ports.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync } from './support/mock-reviewer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const REPO_ROOT = path.join(CLI_ROOT, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const yggRoot = (d: string) => path.join(d, '.yggdrasil');
const cfgPath = (d: string) => path.join(d, '.yggdrasil', 'yg-config.yaml');
const eventsPath = (d: string) => path.join(d, '.yggdrasil', '.yg-events.jsonl');
const drillResultsPath = (d: string) => path.join(d, '.yggdrasil', '.drill-results.jsonl');
const lockPath = (d: string) => path.join(d, '.yggdrasil', 'yg-lock.nondeterministic.json');

function run(args: string[], cwd: string): { all: string; stdout: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { all: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '', status: r.status };
}
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-drill-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}
function pointReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`), 'utf-8');
}
function writeCase(dir: string, aspect: string, rel: string, content: string): void {
  const abs = path.join(yggRoot(dir), 'aspects', aspect, 'drills', rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}
function jsonlLines(p: string): Record<string, unknown>[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// A distinctive code token embedded in the violates case; the mock refuses any
// prompt that carries it and approves everything else.
const VIOLATES_MARKER = 'DRILL_VIOLATES_MARKER';

describe.skipIf(!distExists)('CLI E2E — yg drill', () => {
  it('(1) deterministic path: pass/pass, exit 0, footer, and NO case source leaks into output', () => {
    const dir = copyFixture('det');
    try {
      // A TODO in the violates case → the check refuses it (expected). A clean
      // file in the satisfies case → the check passes it (expected).
      writeCase(dir, 'no-todo-comments', 'violates-todo/bad.ts', '// TODO: unfinished secret business logic here\nexport const x = 1;\n');
      writeCase(dir, 'no-todo-comments', 'satisfies-clean/good.ts', '// all clean\nexport const y = 2;\n');

      const r = run(['drill', '--aspect', 'no-todo-comments'], dir);
      expect(r.status).toBe(0);
      expect(r.all).toContain("yg drill 'no-todo-comments': 2 pass · 0 MISS · 0 FALSE-ALARM · 0 unrun · 0 unsupported");
      expect(r.all).toContain('violates-todo/bad');
      expect(r.all).toContain('satisfies-clean/good');
      // HONESTY FRAME: the case SOURCE must never appear — only labels + hashes.
      expect(r.all).not.toContain('secret business logic');
      expect(r.all).not.toContain('export const');
      // Deterministic cases emit NO verdict-event (zero-churn keyless invariant).
      expect(jsonlLines(eventsPath(dir)).filter((e) => e.source === 'drill')).toHaveLength(0);
      // But drill-results record both cases.
      const results = jsonlLines(drillResultsPath(dir));
      expect(results).toHaveLength(2);
      expect(results.every((l) => l.kind === 'deterministic' && l.got === (String(l.case).startsWith('violates') ? 'refused' : 'satisfied'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(1b) a corpus that reveals a rule regression → MISS, exit 1', () => {
    const dir = copyFixture('det-miss');
    try {
      // A "violates" case that DOESN'T actually contain a TODO — the check under-fires,
      // so the case the corpus says MUST be refused passes: a MISS.
      writeCase(dir, 'no-todo-comments', 'violates-todo/bad.ts', '// no todo here at all\nexport const x = 1;\n');
      const r = run(['drill', '--aspect', 'no-todo-comments'], dir);
      expect(r.status).toBe(1);
      expect(r.all).toContain('1 MISS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(2) LLM path: pass/pass, budget BEFORE first case, drill events + results, lock untouched', async () => {
    const dir = copyFixture('llm');
    const mock = await startMockReviewer({
      respond: (req) => ({ satisfied: !req.prompt.includes(VIOLATES_MARKER), reason: 'mock' }),
    });
    try {
      pointReviewer(dir, mock.endpoint);
      const lockBefore = existsSync(lockPath(dir)) ? readFileSync(lockPath(dir), 'utf-8') : '';

      // violates-nodoc: code first (no doc comment) AND carries the marker → mock refuses → expected refused → pass.
      writeCase(dir, 'has-doc-comment', 'violates-nodoc/bad.ts', `const ${VIOLATES_MARKER} = 1;\nexport default ${VIOLATES_MARKER};\n`);
      // satisfies-doc: begins with a doc comment → mock approves → expected satisfied → pass.
      writeCase(dir, 'has-doc-comment', 'satisfies-doc/good.ts', '// This file documents itself.\nexport const ok = true;\n');

      const r = await runAsync(['drill', '--aspect', 'has-doc-comment'], dir);
      expect(r.status).toBe(0);
      expect(r.all).toContain('2 pass · 0 MISS · 0 FALSE-ALARM');

      // BUDGET before the first case result line (proven strictly in the unit test;
      // here we confirm the ordering survives end-to-end over stdout).
      const budgetIdx = r.stdout.indexOf('budgeting 2 reviewer call(s)');
      const firstCaseIdx = r.stdout.search(/\b(pass|MISS|FALSE-ALARM|unrun|unsupported)\b/);
      expect(budgetIdx).toBeGreaterThanOrEqual(0);
      expect(budgetIdx).toBeLessThan(firstCaseIdx);
      // Two reviewer calls were actually made.
      expect(mock.chatCount()).toBe(2);

      // One source:'drill' verdict-event per LLM case, carrying tier + judge + votes.
      const drillEvents = jsonlLines(eventsPath(dir)).filter((e) => e.source === 'drill');
      expect(drillEvents).toHaveLength(2);
      for (const e of drillEvents) {
        expect(e.kind).toBe('llm');
        expect(String(e.unitKey).startsWith('drill:has-doc-comment/')).toBe(true);
        expect(e.tier).toBe('standard');
        expect(e.promptRev).toBe(1);
        expect((e.judge as { provider?: string }).provider).toBe('ollama');
      }
      const dispositions = drillEvents.map((e) => e.disposition).sort();
      expect(dispositions).toEqual(['approved', 'refused']);

      // Matching drill-results lines.
      const results = jsonlLines(drillResultsPath(dir));
      expect(results).toHaveLength(2);
      expect(results.every((l) => l.kind === 'llm' && l.tier === 'standard')).toBe(true);

      // The lock was NEVER written by the drill.
      const lockAfter = existsSync(lockPath(dir)) ? readFileSync(lockPath(dir), 'utf-8') : '';
      expect(lockAfter).toBe(lockBefore);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(3) prompt-too-large → unrun, exit 2, reviewer never called', async () => {
    const dir = copyFixture('toolarge');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: true }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Force the size gate: a 10-char prompt cap makes every assembled prompt overflow.
      const p = cfgPath(dir);
      writeFileSync(p, readFileSync(p, 'utf-8').replace(/( {6}consensus: 1\n)/, '$1      max_prompt_chars: 10\n'), 'utf-8');
      writeCase(dir, 'has-doc-comment', 'satisfies-doc/good.ts', '// doc\nexport const ok = true;\n');

      const r = await runAsync(['drill', '--aspect', 'has-doc-comment'], dir);
      expect(r.status).toBe(2);
      expect(r.all).toContain('1 unrun');
      expect(r.all).toContain("over the tier's limit of 10");
      // The size gate fires BEFORE any reviewer call.
      expect(mock.chatCount()).toBe(0);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(4) the shipped in-repo deterministic corpus (wasm-tree-lifecycle) → all pass, exit 0, no source leak', () => {
    const r = run(['drill', '--aspect', 'wasm-tree-lifecycle'], REPO_ROOT);
    expect(r.status).toBe(0);
    expect(r.all).toContain("yg drill 'wasm-tree-lifecycle':");
    expect(r.all).toContain('0 MISS · 0 FALSE-ALARM');
    // Honesty frame: the case files contain real code (`import { … }`,
    // `export function`); the report shows only labels + hashes + verdicts.
    expect(r.all).not.toContain('import {');
    expect(r.all).not.toContain('export function');
  });

  it('(5) unknown aspect → what/why/next error, exit 1', () => {
    const dir = copyFixture('unknown');
    try {
      const r = run(['drill', '--aspect', 'no-such-aspect'], dir);
      expect(r.status).toBe(1);
      expect(r.all).toContain("yg drill requires an aspect declared in .yggdrasil/aspects/ (got 'no-such-aspect')");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
