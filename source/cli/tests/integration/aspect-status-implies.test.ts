import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadGraph } from '../../src/core/graph-loader.js';
import { computeEffectiveAspectStatuses } from '../../src/core/graph/aspects.js';

const YG_CONFIG = `
version: "5.2.0"
reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config: { model: m, endpoint: http://x }
`;

const YG_ARCH = `
node_types:
  service:
    description: Service
    log_required: false
    when:
      path: "src/**"
`;

interface AspectSpec {
  id: string;
  status?: 'draft' | 'advisory' | 'enforced';
  implies?: Array<string | { id: string; status_inherit?: 'strictest' | 'own-default' }>;
}

/**
 * Build a tmp repo with a single node `svc` and the given aspect definitions.
 * The node attaches only the first aspect (the chain head) — B and C reach the
 * node only via the implies fix-point.
 */
function buildRepo(aspects: AspectSpec[], attachedAspectIds: string[]): string {
  const repo = mkdtempSync(join(tmpdir(), 'yg-status-implies-'));
  const ygg = join(repo, '.yggdrasil');
  mkdirSync(join(ygg, 'model', 'svc'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });

  writeFileSync(join(repo, 'src', 'svc.ts'), 'export const x = 1;\n', 'utf-8');
  writeFileSync(join(ygg, 'yg-config.yaml'), YG_CONFIG, 'utf-8');
  writeFileSync(join(ygg, 'yg-architecture.yaml'), YG_ARCH, 'utf-8');

  for (const aspect of aspects) {
    mkdirSync(join(ygg, 'aspects', aspect.id), { recursive: true });
    const status = aspect.status ? `\nstatus: ${aspect.status}` : '';
    let impliesBlock = '';
    if (aspect.implies && aspect.implies.length > 0) {
      const lines = aspect.implies.map(entry => {
        if (typeof entry === 'string') return `  - ${entry}`;
        const inherit = entry.status_inherit
          ? `\n    status_inherit: ${entry.status_inherit}`
          : '';
        return `  - id: ${entry.id}${inherit}`;
      });
      impliesBlock = `\nimplies:\n${lines.join('\n')}`;
    }
    writeFileSync(
      join(ygg, 'aspects', aspect.id, 'yg-aspect.yaml'),
      `name: ${aspect.id.toUpperCase()}
description: t
reviewer:
  type: llm${status}${impliesBlock}
`,
      'utf-8',
    );
    writeFileSync(join(ygg, 'aspects', aspect.id, 'content.md'), `# ${aspect.id}\n`, 'utf-8');
  }

  const aspectList = attachedAspectIds.map(id => `  - ${id}`).join('\n');
  writeFileSync(
    join(ygg, 'model', 'svc', 'yg-node.yaml'),
    `name: svc
type: service
description: svc node
mapping:
  - src/svc.ts
aspects:
${aspectList}
`,
    'utf-8',
  );
  writeFileSync(join(ygg, 'model', 'svc', 'log.md'), '', 'utf-8');
  return repo;
}

describe('integration — aspect-status implies chain (3 levels: A → B → C)', () => {
  const repos: string[] = [];
  afterEach(() => {
    while (repos.length > 0) rmSync(repos.pop()!, { recursive: true, force: true });
  });

  it('strictest default: A enforced + node attaches A → A/B/C all enforced', async () => {
    const repo = buildRepo(
      [
        { id: 'a', status: 'enforced', implies: ['b'] },
        // B's own default is advisory — strictest picks max(enforced, advisory) = enforced.
        { id: 'b', status: 'advisory', implies: ['c'] },
        // C's own default is draft — strictest picks max(enforced, draft) = enforced.
        { id: 'c', status: 'draft' },
      ],
      ['a'],
    );
    repos.push(repo);

    const graph = await loadGraph(repo);
    const svc = graph.nodes.get('svc')!;
    const statuses = computeEffectiveAspectStatuses(svc, graph);

    expect(statuses.get('a')).toBe('enforced');
    expect(statuses.get('b')).toBe('enforced');
    expect(statuses.get('c')).toBe('enforced');
  });

  it('own-default on A→B edge: A enforced → B stays at own default (advisory), C derives from B', async () => {
    const repo = buildRepo(
      [
        // A implies B with status_inherit: own-default → B keeps its own default.
        { id: 'a', status: 'enforced', implies: [{ id: 'b', status_inherit: 'own-default' }] },
        // B's own default is advisory; B→C uses strictest default.
        { id: 'b', status: 'advisory', implies: ['c'] },
        // C's own default is draft; strictest from B(advisory) picks max(advisory, draft) = advisory.
        { id: 'c', status: 'draft' },
      ],
      ['a'],
    );
    repos.push(repo);

    const graph = await loadGraph(repo);
    const svc = graph.nodes.get('svc')!;
    const statuses = computeEffectiveAspectStatuses(svc, graph);

    expect(statuses.get('a')).toBe('enforced');
    expect(statuses.get('b')).toBe('advisory');
    expect(statuses.get('c')).toBe('advisory');
  });

  it('all own-default on both A→B and B→C edges: each implied keeps own default', async () => {
    const repo = buildRepo(
      [
        // A implies B with own-default → B keeps its own (advisory).
        { id: 'a', status: 'enforced', implies: [{ id: 'b', status_inherit: 'own-default' }] },
        // B implies C with own-default → C keeps its own (draft).
        { id: 'b', status: 'advisory', implies: [{ id: 'c', status_inherit: 'own-default' }] },
        { id: 'c', status: 'draft' },
      ],
      ['a'],
    );
    repos.push(repo);

    const graph = await loadGraph(repo);
    const svc = graph.nodes.get('svc')!;
    const statuses = computeEffectiveAspectStatuses(svc, graph);

    expect(statuses.get('a')).toBe('enforced');
    expect(statuses.get('b')).toBe('advisory');
    // C is effective at its own default (draft). Even though B propagates,
    // own-default isolates C from B's effective status.
    expect(statuses.get('c')).toBe('draft');
  });

  it('A at draft: implies do not propagate; B and C absent when not attached elsewhere', async () => {
    const repo = buildRepo(
      [
        { id: 'a', status: 'draft', implies: ['b'] },
        { id: 'b', status: 'advisory', implies: ['c'] },
        { id: 'c', status: 'enforced' },
      ],
      ['a'],
    );
    repos.push(repo);

    const graph = await loadGraph(repo);
    const svc = graph.nodes.get('svc')!;
    const statuses = computeEffectiveAspectStatuses(svc, graph);

    // A is effective at draft (the attach contributes it directly).
    expect(statuses.get('a')).toBe('draft');
    // B and C never enter the effective set: draft impliers do not propagate
    // and neither is attached on any other channel.
    expect(statuses.has('b')).toBe(false);
    expect(statuses.has('c')).toBe(false);
  });
});
