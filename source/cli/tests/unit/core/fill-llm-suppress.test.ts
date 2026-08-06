/**
 * Unit test for the LLM fill stage's handling of a REASONLESS yg-suppress marker
 * in a subject file (core/fill-llm.ts, Task #18 / suppress-range injection).
 *
 * A `yg-suppress(<id>)` with no reason after the closing parenthesis cannot be
 * resolved into a line range, so the suppressed-line set the reviewer must honor
 * is undefined. The fill must therefore fail closed: write NOTHING for the pair,
 * never call the reviewer (callsMade 0), and surface an infra disposition — the
 * SAME shape the deterministic runner produces for the identical marker.
 *
 * HERMETIC: the LLM provider factory is mocked (no network, no real reviewer).
 * Each project is a fresh mkdtemp tree; the lock is read from disk after the run.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';

import { loadGraph } from '../../../src/core/graph-loader.js';
import { runFill } from '../../../src/core/fill.js';
import { readLock } from '../../../src/io/lock-store.js';
import { buildIssueMessage } from '../../../src/formatters/message-builder.js';
import type { IssueMessage } from '../../../src/model/validation.js';
import type { LlmProvider } from '../../../src/llm/types.js';

// ── Mock the LLM provider factory (no real reviewer) ──────────────────────────
vi.mock('../../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));
import { createLlmProvider } from '../../../src/llm/index.js';
const mockCreateLlmProvider = vi.mocked(createLlmProvider);

function makeMockProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    verifyAspect: async () => ({ satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }),
    isAvailable: async () => true,
    ...overrides,
  };
}

const V5_REVIEWER_CONFIG =
  'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
beforeEach(() => {
  vi.resetAllMocks();
});

/** Build a one-node project with a single enforced LLM aspect and the given subject. */
async function setupProject(subjectContent: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-fill-suppress-'));
  dirs.push(root);
  const yggRoot = path.join(root, '.yggdrasil');
  const nodeDir = path.join(yggRoot, 'model', 'svc');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), V5_REVIEWER_CONFIG);
  await writeFile(
    path.join(yggRoot, 'yg-architecture.yaml'),
    'node_types:\n  service:\n    description: s\n    log_required: false\n',
  );
  await writeFile(
    path.join(nodeDir, 'yg-node.yaml'),
    'name: svc\ntype: service\ndescription: x\nmapping:\n  - src/svc.ts\naspects:\n  - llm-a\n',
  );
  await writeFile(path.join(root, 'src', 'svc.ts'), subjectContent);
  const aspDir = path.join(yggRoot, 'aspects', 'llm-a');
  await mkdir(aspDir, { recursive: true });
  await writeFile(
    path.join(aspDir, 'yg-aspect.yaml'),
    'name: llm-a\ndescription: llm-a rule\nreviewer:\n  type: llm\nstatus: enforced\n',
  );
  await writeFile(path.join(aspDir, 'content.md'), 'Every file must do X.\n');
  return root;
}

function makeWriter(): { write: (s: string) => void; emitIssue: (m: IssueMessage) => void; text: () => string } {
  let buf = '';
  const write = (s: string) => { buf += s; };
  return { write, emitIssue: (m) => { write(buildIssueMessage(m) + '\n'); }, text: () => buf };
}

describe('fill-llm: reasonless yg-suppress marker fails closed', () => {
  it('a reasonless marker leaves the pair unverified, calls the reviewer 0 times, and writes nothing', async () => {
    // A single-line marker with NO reason after the ')' — invalid.
    const subject = [
      '// Header comment.',
      'export const x = 1;',
      '// yg-suppress(llm-a)',
      'export const y = 2;',
      '',
    ].join('\n');
    const projectRoot = await setupProject(subject);
    const graph = await loadGraph(projectRoot);

    let verifyCalls = 0;
    mockCreateLlmProvider.mockReturnValue(
      makeMockProvider({
        async verifyAspect() {
          verifyCalls++;
          return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
        },
      }),
    );

    const w = makeWriter();
    const result = await runFill(graph, { coverageVisibleFiles: null, write: w.write, emitIssue: w.emitIssue });

    // Reviewer NEVER called — the marker error fails closed before consensus.
    expect(verifyCalls).toBe(0);
    expect(result.reviewerCallsMade).toBe(0);
    // At least one infra disposition was tallied.
    expect(result.infraFailures).toBeGreaterThanOrEqual(1);
    // NOTHING was written for the pair — it stays unverified.
    const lock = readLock(graph.rootPath);
    expect(lock.verdicts['llm-a']?.['node:svc']).toBeUndefined();
    // The fail-closed notice names the marker location and the missing reason.
    expect(w.text()).toContain('missing its required reason');
  });

  it('the SAME marker WITH a reason resolves cleanly and the reviewer IS called', async () => {
    // Positive control: adding the reason makes the marker valid, so the suppress
    // range resolves and the fill proceeds to the (mocked) reviewer.
    const subject = [
      '// Header comment.',
      'export const x = 1;',
      '// yg-suppress(llm-a) known debt, tracked in the issue tracker',
      'export const y = 2;',
      '',
    ].join('\n');
    const projectRoot = await setupProject(subject);
    const graph = await loadGraph(projectRoot);

    let verifyCalls = 0;
    mockCreateLlmProvider.mockReturnValue(
      makeMockProvider({
        async verifyAspect() {
          verifyCalls++;
          return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
        },
      }),
    );

    const result = await runFill(graph, { coverageVisibleFiles: null, write: () => {} });

    expect(verifyCalls).toBe(1);
    expect(result.reviewerCallsMade).toBe(1);
    const lock = readLock(graph.rootPath);
    expect(lock.verdicts['llm-a']?.['node:svc']?.verdict).toBe('approved');
  });
});
