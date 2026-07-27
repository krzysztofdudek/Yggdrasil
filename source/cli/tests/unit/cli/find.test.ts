import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { findCommand } from '../../../src/cli/find.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setupGraph(opts: { aspectStatus?: 'draft' | 'advisory' | 'enforced' } = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-find-cli-'));
  dirs.push(root);
  const yggRoot = path.join(root, '.yggdrasil');
  await mkdir(path.join(yggRoot, 'model', 'billing', 'cancel'), { recursive: true });
  await mkdir(path.join(yggRoot, 'aspects', 'end-of-period'), { recursive: true });
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.2.0"\n');
  await writeFile(path.join(yggRoot, 'yg-architecture.yaml'), 'node_types:\n  command:\n    description: cmd\n');
  await writeFile(
    path.join(yggRoot, 'model', 'billing', 'yg-node.yaml'),
    'name: billing\ntype: command\ndescription: Billing module\n',
  );
  await writeFile(
    path.join(yggRoot, 'model', 'billing', 'cancel', 'yg-node.yaml'),
    'name: cancel\ntype: command\ndescription: Subscription cancellation workflow\n',
  );
  const statusLine = opts.aspectStatus ? `status: ${opts.aspectStatus}\n` : '';
  await writeFile(
    path.join(yggRoot, 'aspects', 'end-of-period', 'yg-aspect.yaml'),
    `name: End of period\ndescription: cancellation policy\nreviewer:\n  type: llm\n${statusLine}`,
  );
  await writeFile(
    path.join(yggRoot, 'aspects', 'end-of-period', 'content.md'),
    '# End of period\nCancellation takes effect at end of billing period.\n',
  );
  return root;
}

describe('findCommand', () => {
  it('prints top results with Kind line', async () => {
    const root = await setupGraph();
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    const exit = await findCommand('subscription cancellation', root);
    expect(exit).toBe(0);
    const printed = out.join('');
    expect(printed).toContain('Kind: node');
    expect(printed).toMatch(/model\/billing\/cancel/);
  });

  it('ends a node-kind top result with a Next: yg context --node line (model/ stripped)', async () => {
    const root = await setupGraph();
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    const exit = await findCommand('subscription cancellation', root);
    expect(exit).toBe(0);
    // Terminal next-action for a node hit: the model/ prefix is stripped so the
    // path is a valid --node argument.
    expect(out.join('')).toContain('Next: yg context --node billing/cancel');
  });

  it('ends an aspect-kind top result with a Next: read … (not a node) line', async () => {
    const root = await setupGraph();
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    // "period" matches the End-of-period aspect as the top result.
    const exit = await findCommand('period', root);
    expect(exit).toBe(0);
    const printed = out.join('');
    expect(printed).toMatch(/Kind:\s*aspect/);
    expect(printed).toContain(
      'Next: read .yggdrasil/aspects/end-of-period — this is a rule, not an entry-point node (do not pass it to --node).',
    );
  });

  it('emits "No matches." with a Next fallback when query has no hit', async () => {
    const root = await setupGraph();
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    const exit = await findCommand('zzzzzzz nothing here', root);
    expect(exit).toBe(0);
    const printed = out.join('');
    expect(printed).toMatch(/No matches/);
    expect(printed).toContain('Next: run yg tree for the full graph, or re-query with sharper keywords.');
  });

  it('limits to top 5 results', async () => {
    const root = await setupGraph();
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    await findCommand('billing cancellation policy module', root);
    const printed = out.join('');
    const matches = printed.match(/^\d+\./gm) ?? [];
    expect(matches.length).toBeLessThanOrEqual(5);
  });

  it('handles empty graph', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yg-find-empty-'));
    dirs.push(root);
    const yggRoot = path.join(root, '.yggdrasil');
    await mkdir(path.join(yggRoot, 'model'), { recursive: true });
    await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.2.0"\n');
    await writeFile(path.join(yggRoot, 'yg-architecture.yaml'), 'node_types:\n  command:\n    description: c\n');
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    const exit = await findCommand('anything', root);
    expect(exit).toBe(0);
    expect(out.join('')).toMatch(/Empty graph|No matches/);
  });

  it('returns exit 1 on empty query', async () => {
    const root = await setupGraph();
    const exit = await findCommand('', root);
    expect(exit).toBe(1);
  });

  it('renders status line for aspect-kind results (default enforced)', async () => {
    const root = await setupGraph();
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    const exit = await findCommand('period', root);
    expect(exit).toBe(0);
    const printed = out.join('');
    expect(printed).toMatch(/Kind:\s*aspect[\s\S]*status:\s*enforced/);
  });

  it('renders declared aspect status (draft) for aspect-kind results', async () => {
    const root = await setupGraph({ aspectStatus: 'draft' });
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { out.push(String(s)); return true; });
    const exit = await findCommand('period', root);
    expect(exit).toBe(0);
    const printed = out.join('');
    expect(printed).toMatch(/Kind:\s*aspect[\s\S]*status:\s*draft/);
  });
});
