import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadGraph } from '../../src/core/graph-loader.js';
import { validate } from '../../src/core/validator.js';

const YG_CONFIG = `
version: "6.0.0"
reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config: { model: m, endpoint: http://x }
`;

interface RepoLayout {
  arch: string;
  /** map of node path → yg-node.yaml body */
  nodes: Record<string, string>;
  /** map of flow path → yg-flow.yaml body, optional */
  flows?: Record<string, string>;
  /** map of src file path → content */
  sources: Record<string, string>;
}

function buildRepo(layout: RepoLayout): string {
  const repo = mkdtempSync(join(tmpdir(), 'yg-status-downgrade-'));
  const ygg = join(repo, '.yggdrasil');
  mkdirSync(join(ygg, 'aspects', 'a'), { recursive: true });

  writeFileSync(join(ygg, 'yg-config.yaml'), YG_CONFIG, 'utf-8');
  writeFileSync(join(ygg, 'yg-architecture.yaml'), layout.arch, 'utf-8');

  // Aspect 'a' — default enforced (so anchor falls back to enforced when only
  // one explicit lower source exists).
  writeFileSync(
    join(ygg, 'aspects', 'a', 'yg-aspect.yaml'),
    `name: A
description: t
reviewer:
  type: llm
status: enforced
`,
    'utf-8',
  );
  writeFileSync(join(ygg, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');

  for (const [nodePath, body] of Object.entries(layout.nodes)) {
    const dir = join(ygg, 'model', nodePath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'yg-node.yaml'), body, 'utf-8');
    writeFileSync(join(dir, 'log.md'), '', 'utf-8');
  }

  if (layout.flows) {
    for (const [flowPath, body] of Object.entries(layout.flows)) {
      const dir = join(ygg, 'flows', flowPath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'yg-flow.yaml'), body, 'utf-8');
    }
  }

  for (const [relPath, content] of Object.entries(layout.sources)) {
    const abs = join(repo, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  return repo;
}

interface DowngradeIssue {
  code: string;
  nodePath?: string;
  rendered: string;
}

async function getDowngradeIssues(repo: string): Promise<DowngradeIssue[]> {
  const graph = await loadGraph(repo);
  const { issues } = await validate(graph);
  return issues
    .filter(i => i.code === 'aspect-status-downgrade')
    .map(i => ({
      code: i.code ?? 'aspect-status-downgrade',
      nodePath: i.nodePath,
      rendered: `${i.messageData?.what ?? ''}\n${i.messageData?.why ?? ''}\n${i.messageData?.next ?? ''}`,
    }));
}

describe('integration — aspect-status-downgrade across cascade channels', () => {
  const repos: string[] = [];
  afterEach(() => {
    while (repos.length > 0) rmSync(repos.pop()!, { recursive: true, force: true });
  });

  it('channel 1 (own): node attach status < aspect-default → downgrade error', async () => {
    const repo = buildRepo({
      arch: `
node_types:
  service:
    description: Service
    log_required: false
    when:
      path: "src/**"
`,
      nodes: {
        svc: `name: svc
type: service
description: svc
mapping:
  - src/svc.ts
aspects:
  - id: a
    status: advisory
`,
      },
      sources: { 'src/svc.ts': 'export const x = 1;\n' },
    });
    repos.push(repo);

    const downs = await getDowngradeIssues(repo);
    expect(downs.length).toBeGreaterThan(0);
    const onSvc = downs.find(d => d.nodePath === 'svc');
    expect(onSvc).toBeDefined();
    // The message names the site that declares the lower status (the node's
    // own attach) and what the enforced status comes from (the aspect default).
    expect(onSvc!.rendered).toContain("node 'svc' (its own yg-node.yaml) declares status 'advisory'");
    expect(onSvc!.rendered).toContain("as 'enforced' from the aspect default (status: enforced");
  });

  it('channel 2 (ancestor node): parent attaches at advisory, propagates as Ch 2 → downgrade on child', async () => {
    const repo = buildRepo({
      arch: `
node_types:
  module:
    description: Module
    log_required: false
  service:
    description: Service
    log_required: false
    when:
      path: "src/**"
    parents: [module]
`,
      nodes: {
        // Parent organizationally — no mapping. Attaches 'a' at explicit advisory.
        mod: `name: mod
type: module
description: mod
aspects:
  - id: a
    status: advisory
`,
        // Child service inherits 'a' from parent (channel 2).
        'mod/svc': `name: svc
type: service
description: svc
mapping:
  - src/svc.ts
`,
      },
      sources: { 'src/svc.ts': 'export const x = 1;\n' },
    });
    repos.push(repo);

    const downs = await getDowngradeIssues(repo);
    // Parent also fires on Ch 1; what matters is that the child also fires
    // with the ancestor-node origin.
    // Filed once, under the node whose file declares the lower status (the
    // ancestor), never repeated per descendant it reaches.
    const onChild = downs.find(d => d.nodePath === 'mod' && d.rendered.includes('ancestor node'));
    expect(onChild).toBeDefined();
    expect(onChild!.rendered).toContain("ancestor node 'mod' declares status");
    expect(onChild!.rendered).toContain("node 'mod/svc'");
  });

  it('channel 3 (own arch type): type-level explicit status < aspect-default → downgrade', async () => {
    const repo = buildRepo({
      arch: `
node_types:
  service:
    description: Service
    log_required: false
    when:
      path: "src/**"
    aspects:
      - id: a
        status: advisory
`,
      nodes: {
        svc: `name: svc
type: service
description: svc
mapping:
  - src/svc.ts
`,
      },
      sources: { 'src/svc.ts': 'export const x = 1;\n' },
    });
    repos.push(repo);

    const downs = await getDowngradeIssues(repo);
    // A type's declaration is made outside every node: one finding, no node.
    const onSvc = downs.find(d => d.nodePath === undefined);
    expect(onSvc).toBeDefined();
    expect(onSvc!.rendered).toContain("node type 'service' in yg-architecture.yaml declares status");
    expect(onSvc!.rendered).toContain("node 'svc'");
  });

  it('channel 4 (ancestor arch type): parent type default advisory propagates as Ch 4 → downgrade on child', async () => {
    const repo = buildRepo({
      arch: `
node_types:
  module:
    description: Module
    log_required: false
    aspects:
      - id: a
        status: advisory
  service:
    description: Service
    log_required: false
    when:
      path: "src/**"
    parents: [module]
`,
      nodes: {
        mod: `name: mod
type: module
description: mod
`,
        'mod/svc': `name: svc
type: service
description: svc
mapping:
  - src/svc.ts
`,
      },
      sources: { 'src/svc.ts': 'export const x = 1;\n' },
    });
    repos.push(repo);

    const downs = await getDowngradeIssues(repo);
    // Filed under the ancestor whose type declares it, once.
    const onChild = downs.find(d => d.nodePath === 'mod');
    expect(onChild).toBeDefined();
    // Ch 4 origin format is "ancestor-type:module@mod".
    expect(onChild!.rendered).toContain("node type 'module' in yg-architecture.yaml (via ancestor 'mod') declares status");
  });

  it('channel 5 (flow): flow attaches at advisory, aspect-default enforced → downgrade on flow channel', async () => {
    const repo = buildRepo({
      arch: `
node_types:
  service:
    description: Service
    log_required: false
    when:
      path: "src/**"
`,
      nodes: {
        svc: `name: svc
type: service
description: svc
mapping:
  - src/svc.ts
`,
      },
      flows: {
        f: `name: f
description: a flow
nodes:
  - svc
aspects:
  - id: a
    status: advisory
`,
      },
      sources: { 'src/svc.ts': 'export const x = 1;\n' },
    });
    repos.push(repo);

    const downs = await getDowngradeIssues(repo);
    // A flow's declaration is made outside every node: one finding, no node.
    const onSvc = downs.find(d => d.nodePath === undefined);
    expect(onSvc).toBeDefined();
    // The flow is the site that says advisory; it must be named as the
    // declaring site, never as the source of 'enforced', and the node that
    // attaches nothing must not be blamed for attaching.
    expect(onSvc!.rendered).toContain("flow 'f' declares status 'advisory'");
    expect(onSvc!.rendered).toContain("as 'enforced' from the aspect default");
    expect(onSvc!.rendered).not.toContain("Node 'svc' attaches");
    expect(onSvc!.rendered).toContain("set a lower status: in the aspect's yg-aspect.yaml");
  });

  it('channel 6 (port): consumer node attaches at advisory while port declares enforced → downgrade on own attach', async () => {
    // Port channel construction: target with a port carrying 'a' at the
    // aspect default (enforced — non-explicit anchor wise, but the port's
    // declaration matches so it does not trigger a downgrade on target).
    // Consumer declares the same aspect at explicit advisory → Ch 1 on
    // consumer is the explicit-low source while Ch 6 contributes enforced
    // → downgrade fires on consumer's Ch 1 (own:consumer).
    const repo = buildRepo({
      arch: `
node_types:
  service:
    description: Service
    log_required: false
    when:
      path: "src/**"
    relations:
      calls: [service]
`,
      nodes: {
        target: `name: target
type: service
description: target
mapping:
  - src/target.ts
ports:
  p:
    description: port p
    aspects:
      - id: a
        status: enforced
`,
        consumer: `name: consumer
type: service
description: consumer
mapping:
  - src/consumer.ts
aspects:
  - id: a
    status: advisory
relations:
  - target: target
    type: calls
    consumes: [p]
`,
      },
      sources: {
        'src/target.ts': 'export const x = 1;\n',
        'src/consumer.ts': 'export const y = 1;\n',
      },
    });
    repos.push(repo);

    const downs = await getDowngradeIssues(repo);
    const onConsumer = downs.find(d => d.nodePath === 'consumer');
    expect(onConsumer).toBeDefined();
    // The enforced status reaches the consumer from the aspect default AND the
    // port's explicit declaration; both are named.
    expect(onConsumer!.rendered).toContain("node 'consumer' (its own yg-node.yaml) declares status 'advisory'");
    expect(onConsumer!.rendered).toMatch(/from the aspect default .* and port '\w+' on node 'target'/);
  });
});
