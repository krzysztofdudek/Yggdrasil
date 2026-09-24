// Hermetic E2E — further LLM REVIEWER mechanics via the in-process mock (see
// support/mock-reviewer.ts and cli-llm-reviewer-mock.test.ts). Covers the paths the
// first mock suite does not: a node with many source files sends ONE reviewer call per
// LLM aspect (no chunking), a node mixing a deterministic and an LLM aspect (only the
// LLM one calls the reviewer), several LLM aspects each consuming consensus calls, the
// 429 retry, and how a refused LLM verdict renders in `yg check` (advisory warning vs
// enforced error). All deterministic, in CI.
//
// Verification runs at FILL time via `yg check --approve` (repo-wide): one reviewer
// call per LLM pair, ×consensus. The e2e-lifecycle fixture has the enforced LLM aspect
// has-doc-comment on its TWO service nodes (orders, payments).

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockReviewer, runAsync, type ChatReply } from './support/mock-reviewer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '..', '..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');
const distExists = existsSync(BIN_PATH);

const cfgPath = (dir: string) => path.join(dir, '.yggdrasil', 'yg-config.yaml');
const ordersNodeYaml = (dir: string) => path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');

function fixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-llmmockx-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function pointReviewer(dir: string, endpoint: string): void {
  const p = cfgPath(dir);
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/endpoint:\s*["']?[^"'\n]+["']?/, `endpoint: "${endpoint}"`), 'utf-8');
}

function setAspectStatus(dir: string, status: 'draft' | 'advisory' | 'enforced'): void {
  const p = path.join(dir, '.yggdrasil', 'aspects', 'has-doc-comment', 'yg-aspect.yaml');
  writeFileSync(p, readFileSync(p, 'utf-8').replace(/status:\s*\w+/, `status: ${status}`), 'utf-8');
}

const ALWAYS_OK: () => ChatReply = () => ({ satisfied: true, reason: 'ok' });

describe.skipIf(!distExists)('CLI E2E — LLM reviewer mechanics via mock (extended)', () => {
  it('1: a node with multiple large source files sends exactly ONE reviewer call per LLM aspect (no chunking)', async () => {
    const dir = fixture('no-chunk');
    // Chunking has been removed. The prompt-size gate (max_prompt_chars) is the
    // sole guarantee a node fits one prompt — no matter the total source size
    // below that gate, the reviewer is called exactly once per LLM aspect.
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);
      // Add two large source files (~4000 chars each, still well under any prompt
      // gate) so the former chunking logic would have produced multiple calls —
      // verifying that it no longer does.
      const big = (tag: string) => `// ${tag}\nexport const ${tag} = ${JSON.stringify('x'.repeat(4000))};\n`;
      writeFileSync(path.join(dir, 'src', 'services', 'big1.ts'), big('big1'), 'utf-8');
      writeFileSync(path.join(dir, 'src', 'services', 'big2.ts'), big('big2'), 'utf-8');
      writeFileSync(
        ordersNodeYaml(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          'mapping:',
          '  - src/services/orders.ts',
          '  - src/services/big1.ts',
          '  - src/services/big2.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      const r = await runAsync(['check', '--approve'], dir);
      expect(r.status).toBe(0);
      // One enforced LLM aspect (has-doc-comment) at consensus 1 across the TWO
      // service nodes → exactly TWO reviewer calls, one per node (NOT one per file).
      expect(mock.chatCount()).toBe(2);
      // The orders prompt contains ALL of the orders node's source files.
      const ordersPrompt = mock.chatRequests.find((c) => c.prompt.includes('services/orders'))!.prompt;
      expect(ordersPrompt).toContain('big1');
      expect(ordersPrompt).toContain('big2');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2: a node mixing a deterministic and an LLM aspect calls the reviewer only for the LLM aspect', async () => {
    const dir = fixture('mixed');
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);
      // The service type already carries deterministic aspects (no-todo-comments,
      // requires-named-export) AND the LLM has-doc-comment. A clean fill runs the
      // deterministic checks locally (zero cost) and issues ONE reviewer call per
      // LLM pair — two across the two service nodes.
      const r = await runAsync(['check', '--approve'], dir);
      expect(r.status).toBe(0);
      expect(mock.chatCount()).toBe(2);
      // The deterministic aspects fill locally (the `fill` header counts them as
      // free script pairs) and never reach the reviewer.
      expect(r.stderr).toMatch(/^fill {2}\d+ pairs · \d+ script \(free\) · 2 reviewer calls \(consensus included\)$/m);
      // The reviewer calls are for the LLM aspect only.
      const prompts = mock.chatRequests.map((c) => c.prompt).join('\n');
      expect(prompts).toContain('has-doc-comment');
      expect(prompts).not.toContain('no-todo-comments');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3: two LLM aspects each issue their own reviewer call per node', async () => {
    const dir = fixture('two-llm');
    const mock = await startMockReviewer({ respond: ALWAYS_OK });
    try {
      pointReviewer(dir, mock.endpoint);
      // Author a second LLM aspect and attach it to the orders node directly
      // (keeping wip-rule so it does not become orphaned).
      const aspDir = path.join(dir, '.yggdrasil', 'aspects', 'second-llm');
      mkdirSync(aspDir, { recursive: true });
      writeFileSync(path.join(aspDir, 'yg-aspect.yaml'), 'name: SecondLlm\ndescription: A second LLM rule.\nreviewer:\n  type: llm\nstatus: enforced\n', 'utf-8');
      writeFileSync(path.join(aspDir, 'content.md'), 'The file must be reasonable.\n', 'utf-8');
      writeFileSync(
        ordersNodeYaml(dir),
        [
          'name: OrdersService',
          'description: Creates and retrieves customer orders.',
          'type: service',
          'aspects:',
          '  - wip-rule',
          '  - second-llm',
          'mapping:',
          '  - src/services/orders.ts',
          '',
        ].join('\n'),
        'utf-8',
      );
      const r = await runAsync(['check', '--approve'], dir);
      expect(r.status).toBe(0);
      // has-doc-comment (type default) on BOTH service nodes = 2 calls; second-llm
      // (own to orders) = 1 call. Three LLM pairs, one reviewer call each.
      expect(mock.chatCount()).toBe(3);
      const prompts = mock.chatRequests.map((c) => c.prompt).join('\n');
      expect(prompts).toContain('has-doc-comment');
      expect(prompts).toContain('second-llm');
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: a 429 is retried once and then succeeds (extra request, the fill passes)', async () => {
    const dir = fixture('retry');
    // The first chat call returns 429, every later call returns a verdict. The one
    // retried call adds a single extra request on top of the two LLM pairs.
    const mock = await startMockReviewer({
      respond: (_r, i) => (i === 0 ? { httpStatus: 429 } : { satisfied: true, reason: 'ok after retry' }),
    });
    try {
      pointReviewer(dir, mock.endpoint);
      const r = await runAsync(['check', '--approve'], dir);
      expect(r.status).toBe(0);
      // apiFetch retries once on 429 → the first pair makes 2 requests, the second
      // makes 1 → three requests for two LLM pairs.
      expect(mock.chatCount()).toBe(3);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: a refused ENFORCED LLM verdict renders as a blocking error in yg check', async () => {
    const dir = fixture('check-enforced');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: false, reason: 'missing the file comment' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Fill the whole repo so the only check findings are the recorded refused
      // verdicts (not an unverified pair).
      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(1); // refused enforced verdict
      // The fill no longer prints a per-pair line; the refusals are counted on
      // the closing line and named, per node, in the report's refused block.
      expect(fill.all).toMatch(/^fill {2}done in .* — \d+ passed · 2 refused · 0 failed · 2 reviewer calls/m);
      expect(fill.all).toMatch(/^error\[refused\] has-doc-comment — refused on 2 nodes$/m);
      expect(fill.all).toMatch(/^ {2}at: {3}services\/orders +missing the file comment$/m);
      // yg check renders the stored refused enforced verdict as a blocking error
      // WITHOUT re-calling the reviewer.
      const before = mock.chatCount();
      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('has-doc-comment');
      // An enforced refusal is an ERROR block (the label says refused, the
      // severity says it blocks).
      expect(check.all).toMatch(/^error\[refused\] has-doc-comment — refused on 2 nodes$/m);
      expect(mock.chatCount()).toBe(before); // check does not call the reviewer
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6: a refused ADVISORY LLM verdict renders as a non-blocking warning in yg check (exit 0)', async () => {
    const dir = fixture('check-advisory');
    const mock = await startMockReviewer({ respond: () => ({ satisfied: false, reason: 'advisory: no comment' }) });
    try {
      pointReviewer(dir, mock.endpoint);
      // Flip has-doc-comment to advisory.
      setAspectStatus(dir, 'advisory');
      // An advisory refusal does not block the fill (exit 0) but records the verdict.
      const fill = await runAsync(['check', '--approve'], dir);
      expect(fill.status).toBe(0);
      expect(fill.all).toMatch(/^fill {2}done in .* — \d+ passed · 2 refused · 0 failed · 2 reviewer calls/m);
      expect(fill.all).toMatch(/^ {2}at: {3}services\/orders +advisory: no comment$/m);
      // yg check renders the advisory violations as non-blocking warnings (exit 0).
      const check = await runAsync(['check'], dir);
      expect(check.status).toBe(0);
      expect(check.all).toContain('has-doc-comment');
      expect(check.all.toLowerCase()).toContain('advisory');
      // The advisory refusal is NON-BLOCKING: it renders as a `warning[refused]`
      // block (exit 0), and the reviewer's reason stays on the member line.
      expect(check.all).toMatch(/^yg check: PASS {2}\d+ warnings /m);
      expect(check.all).toMatch(/^warning\[refused\] has-doc-comment — refused on 2 nodes$/m);
      expect(check.all).toMatch(/^ {2}at: {3}services\/orders +advisory: no comment$/m);
      expect(check.all).not.toMatch(/^error\[/m);
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
