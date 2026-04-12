import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlow } from '../../../src/io/flow-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  it('prefers nodes over participants when both present', async () => {
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

    const flow = await parseFlow(tmpDir, flowYaml);

    expect(flow.nodes).toEqual(['a/b']);

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
      'must contain string node paths',
    );

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

  it('returns empty aspects when all entries are non-string', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-flow-nonstring-aspects');
    await mkdir(tmpDir, { recursive: true });
    const flowYaml = path.join(tmpDir, 'yg-flow.yaml');
    await writeFile(flowYaml, 'name: Test\nnodes: [a/b]\naspects: [123, true]\n', 'utf-8');

    const flow = await parseFlow(tmpDir, flowYaml);

    expect(flow.aspects).toEqual([]);

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
