import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlow } from '../../../src/io/flow-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '../../fixtures');

afterEach(async () => {
  const entries = await readdir(FIXTURES_DIR).catch(() => []);
  await Promise.all(
    entries
      .filter((e) => e.startsWith('tmp-flow'))
      .map((e) => rm(path.join(FIXTURES_DIR, e), { recursive: true, force: true })),
  );
});

describe('flow-parser', () => {
  it('parses valid yg-flow.yaml correctly', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(
      flowYaml,
      `
name: Checkout Flow
nodes:
  - orders/order-service
  - auth/auth-api
`,
      'utf-8',
    );

    const flow = await parseFlow(tmpDir, flowYaml);

    expect(flow.name).toBe('Checkout Flow');
    expect(flow.nodes).toEqual(['orders/order-service', 'auth/auth-api']);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws on empty YAML file', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-empty');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(flowYaml, '', 'utf-8');

    await expect(parseFlow(tmpDir, flowYaml)).rejects.toThrow(
      'empty or not a valid YAML mapping',
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when name is missing', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-missing-name');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(
      flowYaml,
      `
nodes:
  - a/b
`,
      'utf-8',
    );

    await expect(parseFlow(tmpDir, flowYaml)).rejects.toThrow("missing or empty 'name'");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when name is empty string', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-empty-name');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(
      flowYaml,
      `
name: "   "
nodes:
  - a/b
`,
      'utf-8',
    );

    await expect(parseFlow(tmpDir, flowYaml)).rejects.toThrow("missing or empty 'name'");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('accepts participants as alias for nodes', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-participants');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(
      flowYaml,
      `
name: Compat Flow
participants:
  - orders/order-service
  - auth/auth-api
`,
      'utf-8',
    );

    const flow = await parseFlow(tmpDir, flowYaml);

    expect(flow.name).toBe('Compat Flow');
    expect(flow.nodes).toEqual(['orders/order-service', 'auth/auth-api']);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('refuses a flow that declares both nodes and participants', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-both');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(
      flowYaml,
      `
name: Both Flow
nodes:
  - a/b
participants:
  - c/d
`,
      'utf-8',
    );

    // Taking one list silently dropped the other: a ghost participant there
    // escaped flow-node-broken and the flow's rules.
    await expect(parseFlow(tmpDir, flowYaml)).rejects.toThrow("declares both 'nodes' and 'participants'");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when nodes is missing', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-missing-nodes');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(
      flowYaml,
      `
name: Test Flow
`,
      'utf-8',
    );

    await expect(parseFlow(tmpDir, flowYaml)).rejects.toThrow(
      "'nodes' (or 'participants') must be a non-empty array",
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when nodes is empty array', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-empty-nodes');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(
      flowYaml,
      `
name: Test Flow
nodes: []
`,
      'utf-8',
    );

    await expect(parseFlow(tmpDir, flowYaml)).rejects.toThrow('must be a non-empty array');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when nodes contains no strings', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-nonstring-nodes');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(
      flowYaml,
      `
name: Test Flow
nodes: [123, {}]
`,
      'utf-8',
    );

    await expect(parseFlow(tmpDir, flowYaml)).rejects.toThrow(
      /'nodes'.*contains non-string entries/,
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when nodes contains a mix of strings and non-strings (no silent drop)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-mixed-nodes');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(
      flowYaml,
      `
name: Test Flow
nodes:
  - a/first
  - 42
  - b/second
`,
      'utf-8',
    );

    // The middle entry (42) must NOT be silently dropped: parsing must fail loud,
    // naming the field and the offending value at its index.
    const err = await parseFlow(tmpDir, flowYaml).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/'nodes'.*contains non-string entry/);
    expect(err?.message).toContain('index 1');
    expect(err?.message).toContain('42');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses an all-string nodes array unchanged (control)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-allstring-nodes');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(
      flowYaml,
      `
name: Test Flow
nodes:
  - a/first
  - b/second
`,
      'utf-8',
    );

    const flow = await parseFlow(tmpDir, flowYaml);
    expect(flow.nodes).toEqual(['a/first', 'b/second']);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('trims name', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-trim');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(
      flowYaml,
      `
name: "  Checkout Flow  "
nodes: [a/b]
`,
      'utf-8',
    );

    const flow = await parseFlow(tmpDir, flowYaml);
    expect(flow.name).toBe('Checkout Flow');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses optional aspects array', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-aspects');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(
      flowYaml,
      `
name: Saga Flow
nodes: [a/b]
aspects:
  - requires-saga
  - requires-idempotency
`,
      'utf-8',
    );

    const flow = await parseFlow(tmpDir, flowYaml);

    expect(flow.aspects).toEqual(['requires-saga', 'requires-idempotency']);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('sets path to basename of flowDir', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-path');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(flowYaml, 'name: Path Test\nnodes: [a/b]', 'utf-8');

    const flow = await parseFlow(tmpDir, flowYaml);

    expect(flow.path).toBe(path.basename(tmpDir));

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when aspects is not an array', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-bad-aspects');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(flowYaml, 'name: Test\nnodes: [a/b]\naspects: "not-an-array"\n', 'utf-8');

    await expect(parseFlow(tmpDir, flowYaml)).rejects.toThrow(
      "'aspects' must be an array of strings",
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when aspects entries are non-string non-object', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-nonstring-aspects');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(flowYaml, 'name: Test\nnodes: [a/b]\naspects: [123, true]\n', 'utf-8');

    await expect(parseFlow(tmpDir, flowYaml)).rejects.toThrow();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when aspects absent', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-no-aspects');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(flowYaml, 'name: Plain\nnodes: [a/b]', 'utf-8');

    const flow = await parseFlow(tmpDir, flowYaml);

    expect(flow.aspects).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses description field when present', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-desc');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(
      flowYaml,
      `
name: Described Flow
nodes:
  - a/b
description: "test flow desc"
`,
      'utf-8',
    );

    const flow = await parseFlow(tmpDir, flowYaml);
    expect(flow.description).toBe('test flow desc');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('description is undefined when not present in YAML', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-no-desc');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(flowYaml, 'name: No Desc Flow\nnodes: [a/b]', 'utf-8');

    const flow = await parseFlow(tmpDir, flowYaml);
    expect(flow.description).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe('flow-parser — when filter', () => {
  it('parses object form in aspects', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-when');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(
      flowYaml,
      [
        'name: CheckoutFlow',
        'nodes: [orders]',
        'aspects:',
        '  - transactional',
        '  - id: deterministic',
        '    when: { node: { type: command } }',
      ].join('\n'),
      'utf-8',
    );

    const result = await parseFlow(tmpDir, flowYaml);
    expect(result.aspects).toEqual(['transactional', 'deterministic']);
    expect(result.aspectWhens).toEqual({
      deterministic: { node: { type: 'command' } },
    });

    await rm(tmpDir, { recursive: true, force: true });
  });
});
