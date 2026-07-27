import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { findCommand } from '../../src/cli/find.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function richGraph(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-find-int-'));
  dirs.push(root);
  const ygg = path.join(root, '.yggdrasil');
  await mkdir(path.join(ygg, 'model', 'orders', 'place'), { recursive: true });
  await mkdir(path.join(ygg, 'model', 'billing', 'cancel'), { recursive: true });
  await mkdir(path.join(ygg, 'aspects', 'audit-logging'), { recursive: true });
  await writeFile(path.join(ygg, 'yg-config.yaml'), 'version: "5.2.0"\n');
  await writeFile(path.join(ygg, 'yg-architecture.yaml'), 'node_types:\n  command:\n    description: cmd\n');
  await writeFile(path.join(ygg, 'model', 'orders', 'yg-node.yaml'), 'name: orders\ntype: command\ndescription: Order management\n');
  await writeFile(path.join(ygg, 'model', 'orders', 'place', 'yg-node.yaml'), 'name: place\ntype: command\ndescription: Place a new order\n');
  await writeFile(path.join(ygg, 'model', 'billing', 'yg-node.yaml'), 'name: billing\ntype: command\ndescription: Billing module\n');
  await writeFile(path.join(ygg, 'model', 'billing', 'cancel', 'yg-node.yaml'), 'name: cancel\ntype: command\ndescription: Subscription cancellation workflow\n');
  await writeFile(
    path.join(ygg, 'model', 'billing', 'cancel', 'log.md'),
    '## [2026-05-11T10:00:00.000Z]\nChanged to end-of-period.\n',
  );
  await writeFile(path.join(ygg, 'aspects', 'audit-logging', 'yg-aspect.yaml'), 'name: Audit\ndescription: emit audit events for sensitive changes\nreviewer:\n  type: llm\n');
  await writeFile(path.join(ygg, 'aspects', 'audit-logging', 'content.md'), 'rule.\n');
  return root;
}

describe('yg find integration', () => {
  it('exact-keyword match returns relevant node first', async () => {
    const root = await richGraph();
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    await findCommand('subscription cancellation', root);
    const printed = out.join('');
    // billing/cancel should appear and be the first numbered result
    expect(printed.indexOf('billing/cancel')).toBeGreaterThan(-1);
    const firstResultIdx = printed.indexOf('1.');
    expect(printed.indexOf('billing/cancel')).toBeGreaterThan(firstResultIdx - 1);
    expect(printed.indexOf('billing/cancel')).toBeLessThan(printed.indexOf('2.') === -1 ? Infinity : printed.indexOf('2.'));
  });

  it('fuzzy typo tolerance', async () => {
    const root = await richGraph();
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    await findCommand('cuncellation', root); // 1-char typo: a→u, edit distance 1
    expect(out.join('')).toMatch(/billing\/cancel/);
  });

  it('log.md content boosts node match', async () => {
    const root = await richGraph();
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    await findCommand('end-of-period', root);
    expect(out.join('')).toMatch(/billing\/cancel/);
  });

  it('aspect hits appear with Kind: aspect', async () => {
    const root = await richGraph();
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    await findCommand('audit events', root);
    const printed = out.join('');
    expect(printed).toMatch(/Kind: aspect/);
    expect(printed).toMatch(/aspects\/audit-logging/);
  });

  it('appends a Next: yg context --node line for a node-kind top result', async () => {
    const root = await richGraph();
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    await findCommand('subscription cancellation', root);
    expect(out.join('')).toContain('Next: yg context --node billing/cancel');
  });

  it('appends a Next: read … (rule, not a node) line for an aspect-kind top result', async () => {
    const root = await richGraph();
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    await findCommand('audit events', root);
    expect(out.join('')).toContain(
      'Next: read .yggdrasil/aspects/audit-logging — this is a rule, not an entry-point node (do not pass it to --node).',
    );
  });
});
