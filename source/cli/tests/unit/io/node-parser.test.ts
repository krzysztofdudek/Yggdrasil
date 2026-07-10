import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNodeYaml } from '../../../src/io/node-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '../../fixtures/sample-project/.yggdrasil/model');
const FIXTURES_DIR = path.join(__dirname, '../../fixtures');

afterEach(async () => {
  const entries = await readdir(FIXTURES_DIR).catch(() => []);
  await Promise.all(
    entries
      .filter((e) => e.startsWith('tmp-node') || e.startsWith('tmp-flat') || e.startsWith('tmp-old') || e.startsWith('tmp-port'))
      .map((e) => rm(path.join(FIXTURES_DIR, e), { recursive: true, force: true })),
  );
});

describe('node-parser', () => {
  it('parses valid yg-node.yaml correctly (v4.0)', async () => {
    const meta = await parseNodeYaml(path.join(FIXTURE_DIR, 'orders/order-service/yg-node.yaml'));

    expect(meta.name).toBe('OrderService');
    expect(meta.type).toBe('service');
    expect(meta.relations).toContainEqual(
      expect.objectContaining({ target: 'auth/auth-api', type: 'uses' }),
    );
    expect(meta.relations).toContainEqual(
      expect.objectContaining({ target: 'users/user-repo', type: 'uses' }),
    );
    expect(meta.mapping).toEqual(['src/orders/order.service.ts']);
  });

  // --- Reviewed-seam per-node max_direct_relations override ---
  // Parser-tolerant by contract: a well-formed override (integer limit >= 1 AND a
  // non-empty justification) is honoured; absent OR malformed → undefined, so the
  // strict global default applies and a partial/typo'd override never loosens it.

  async function parseWithMaxRel(body: string): Promise<Awaited<ReturnType<typeof parseNodeYaml>>> {
    const tmpDir = path.join(FIXTURES_DIR, 'tmp-node-maxrel');
    await mkdir(tmpDir, { recursive: true });
    const p = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(p, `name: Seam\ntype: service\ndescription: "A reviewed seam."\n${body}`, 'utf-8');
    const meta = await parseNodeYaml(p);
    await rm(tmpDir, { recursive: true, force: true });
    return meta;
  }

  it('parses a well-formed max_direct_relations override (limit + reason)', async () => {
    const meta = await parseWithMaxRel(
      'max_direct_relations:\n  limit: 21\n  reason: "Single auditable gateway; splitting defeats the seam."\n',
    );
    expect(meta.maxDirectRelations).toEqual({
      limit: 21,
      reason: 'Single auditable gateway; splitting defeats the seam.',
    });
  });

  it('treats an absent max_direct_relations as undefined (global default applies)', async () => {
    const meta = await parseWithMaxRel('');
    expect(meta.maxDirectRelations).toBeUndefined();
  });

  it('tolerates a malformed max_direct_relations (scalar) — undefined, no throw', async () => {
    const meta = await parseWithMaxRel('max_direct_relations: 21\n');
    expect(meta.maxDirectRelations).toBeUndefined();
  });

  it('tolerates a partial max_direct_relations missing its justification — undefined', async () => {
    const meta = await parseWithMaxRel('max_direct_relations:\n  limit: 21\n');
    expect(meta.maxDirectRelations).toBeUndefined();
  });

  it('rejects a non-integer or empty-reason override as malformed — undefined', async () => {
    const nonInt = await parseWithMaxRel('max_direct_relations:\n  limit: 21.5\n  reason: "x"\n');
    expect(nonInt.maxDirectRelations).toBeUndefined();
    const emptyReason = await parseWithMaxRel('max_direct_relations:\n  limit: 21\n  reason: "   "\n');
    expect(emptyReason.maxDirectRelations).toBeUndefined();
  });

  it('throws on empty YAML file', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-empty');
    await mkdir(tmpDir, { recursive: true });
    const badPath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(badPath, '', 'utf-8');

    await expect(parseNodeYaml(badPath)).rejects.toThrow('empty or not a valid YAML mapping');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when name is missing', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node');
    await mkdir(tmpDir, { recursive: true });
    const badPath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      badPath,
      `
type: service
`,
      'utf-8',
    );

    await expect(parseNodeYaml(badPath)).rejects.toThrow("missing or empty 'name'");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when type is missing', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node');
    await mkdir(tmpDir, { recursive: true });
    const badPath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      badPath,
      `
name: TestNode
`,
      'utf-8',
    );

    await expect(parseNodeYaml(badPath)).rejects.toThrow("missing or empty 'type'");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('handles mapping paths (flat string array)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: TestNode
type: service
mapping:
  - src/modules/test/service.ts
`,
      'utf-8',
    );

    const meta = await parseNodeYaml(nodePath);
    expect(meta.mapping).toEqual(['src/modules/test/service.ts']);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when mapping contains object instead of string', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: TestNode
type: service
mapping:
  - type: directory
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow(/flat list of file\/directory paths/i);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when mapping is not an array', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: TestNode
type: service
mapping: "not-array"
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('mapping');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when mapping array contains non-string entries', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: TestNode
type: service
mapping:
  - 1
  - 2
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('must be a non-empty string');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('handles mapping with multiple paths', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: TestNode
type: component
mapping:
  - app/page.tsx
  - app/loading.tsx
`,
      'utf-8',
    );

    const meta = await parseNodeYaml(nodePath);
    expect(meta.mapping).toEqual(['app/page.tsx', 'app/loading.tsx']);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('defaults missing optional fields correctly', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: MinimalNode
type: module
`,
      'utf-8',
    );

    const meta = await parseNodeYaml(nodePath);
    expect(meta.aspects).toBeUndefined();
    expect(meta.relations).toBeUndefined();
    expect(meta.mapping).toBeUndefined();
    expect(meta.ports).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses node with aspects field (new format)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-aspects');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: AspectedNode
type: service
aspects:
  - "requires-auth"
  - "public-api"
`,
      'utf-8',
    );

    const meta = await parseNodeYaml(nodePath);
    expect(meta.aspects).toEqual(['requires-auth', 'public-api']);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when mapping is empty object', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-no-path');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: NoPathNode
type: service
mapping: {}
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('must be an array');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when mapping contains empty string', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-empty-path');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: EmptyPath
type: service
mapping:
  - ""
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('must be a non-empty string');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when mapping contains absolute path', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-abs-path');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: AbsPath
type: service
mapping:
  - /absolute/path.ts
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('relative to repository root');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when mapping is an empty array', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-empty-paths');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: EmptyPaths
type: service
mapping: []
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('mapping');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when relations is not array', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-relations-not-array');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: BadRels
type: service
relations: "not-array"
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow("'relations' must be an array");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when relation target is empty string', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-empty-target');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: BadRel
type: service
relations:
  - target: ""
    type: uses
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('target must be a non-empty string');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when relation is not object', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-rel-not-obj');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: BadRel
type: service
relations:
  - "not-an-object"
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('must be an object');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when mapping has type directory but no paths', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-dir-no-path');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: NoPath
type: service
mapping:
  - type: directory
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('mapping');

    await rm(tmpDir, { recursive: true, force: true });
  });


  it('throws when mapping is an object instead of array', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-mapping-legacy');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: LegacyMapping
type: service
mapping:
  paths:
    - src/legacy/module.ts
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('must be an array');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when relation type is invalid', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-invalid-rel-type');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: BadRel
type: service
relations:
  - target: other
    type: invalid_type
`,
      'utf-8',
    );

    await expect(parseNodeYaml(nodePath)).rejects.toThrow('type is invalid');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses relation with event_name for emits/listens', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-event-name');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: EventNode
type: service
relations:
  - target: events/handler
    type: emits
    event_name: OrderCreated
`,
      'utf-8',
    );

    const meta = await parseNodeYaml(nodePath);
    expect(meta.relations).toHaveLength(1);
    expect(meta.relations![0]).toEqual({
      target: 'events/handler',
      type: 'emits',
      event_name: 'OrderCreated',
    });

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses node with relations including consumes', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-rels');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: RelatedNode
type: service
relations:
  - target: auth/auth-api
    type: uses
    consumes: [login, logout]
  - target: users/user-repo
    type: calls
`,
      'utf-8',
    );

    const meta = await parseNodeYaml(nodePath);
    expect(meta.relations).toHaveLength(2);
    expect(meta.relations![0]).toEqual({
      target: 'auth/auth-api',
      type: 'uses',
      consumes: ['login', 'logout'],
    });
    expect(meta.relations![1]).toEqual({
      target: 'users/user-repo',
      type: 'calls',
    });

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when relation consumes mixes strings and non-strings (no silent drop)', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-bad-consumes');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: BadConsumes
type: service
relations:
  - target: auth/auth-api
    type: uses
    consumes: [login, 99, logout]
`,
      'utf-8',
    );

    // The middle port (99) must NOT be silently dropped — its port aspects would
    // then go unenforced. Parsing must fail loud, naming the field and the value.
    const err = await parseNodeYaml(nodePath).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/consumes.*contains non-string entry/);
    expect(err?.message).toContain('index 1');
    expect(err?.message).toContain('99');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses flat string aspects array', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-flat-aspects');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(nodePath, `name: FlatAspects\ntype: service\naspects:\n  - "requires-auth"\n  - "audit-logging"\n`, 'utf-8');

    const meta = await parseNodeYaml(nodePath);
    expect(meta.aspects).toEqual([
      'requires-auth',
      'audit-logging',
    ]);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when aspects entry is not a string', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-bad-aspect-entry');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(nodePath, `name: Bad\ntype: service\naspects:\n  - 123\n`, 'utf-8');

    await expect(parseNodeYaml(nodePath)).rejects.toThrow(
      /aspect attachment must be a string or an object/,
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when aspects entry is an object', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-no-aspect-key');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(nodePath, `name: Bad\ntype: service\naspects:\n  - exceptions:\n      - "some note"\n`, 'utf-8');

    await expect(parseNodeYaml(nodePath)).rejects.toThrow(
      /object form requires 'id' as a non-empty string/,
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when aspects entry is an object with exceptions', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-bad-exc-type');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(nodePath, `name: Bad\ntype: service\naspects:\n  - aspect: my-aspect\n    exceptions: "not-array"\n`, 'utf-8');

    await expect(parseNodeYaml(nodePath)).rejects.toThrow(
      /object form requires 'id' as a non-empty string/,
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when duplicate aspect id in aspects list', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-dup-aspect');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(nodePath, `name: Bad\ntype: service\naspects:\n  - "my-aspect"\n  - "my-aspect"\n`, 'utf-8');

    await expect(parseNodeYaml(nodePath)).rejects.toThrow(
      "duplicate aspect 'my-aspect' in aspects list",
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses description field when present', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-desc');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: DescNode
type: service
description: "test desc"
`,
      'utf-8',
    );

    const meta = await parseNodeYaml(nodePath);
    expect(meta.description).toBe('test desc');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('description is undefined when not present in YAML', async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-no-desc');
    await mkdir(tmpDir, { recursive: true });
    const nodePath = path.join(tmpDir, 'yg-node.yaml');
    await writeFile(
      nodePath,
      `
name: NoDescNode
type: service
`,
      'utf-8',
    );

    const meta = await parseNodeYaml(nodePath);
    expect(meta.description).toBeUndefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('node-parser flat mapping', () => {
    it('parses mapping as flat string array', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-flat-mapping');
      await mkdir(tmpDir, { recursive: true });
      const nodePath = path.join(tmpDir, 'yg-node.yaml');
      await writeFile(
        nodePath,
        `
name: Validator
type: library
mapping:
  - source/cli/src/core/validator.ts
  - source/cli/src/core/effective-aspects.ts
`,
        'utf-8',
      );

      const meta = await parseNodeYaml(nodePath);
      expect(meta.mapping).toEqual([
        'source/cli/src/core/validator.ts',
        'source/cli/src/core/effective-aspects.ts',
      ]);

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('rejects mapping group format with objects', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-old-mapping-group');
      await mkdir(tmpDir, { recursive: true });
      const nodePath = path.join(tmpDir, 'yg-node.yaml');
      await writeFile(
        nodePath,
        `
name: Old
type: library
mapping:
  - paths:
      - source/cli/src/core/validator.ts
    aspects:
      - aspect: deterministic
        anchors:
          pure-function:
            regex: "export function"
            rationale: "migrated"
`,
        'utf-8',
      );

      await expect(parseNodeYaml(nodePath)).rejects.toThrow(/flat list of file\/directory paths/i);

      await rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe('node-parser ports', () => {
    it('parses ports with aspects', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-ports-with-aspects');
      await mkdir(tmpDir, { recursive: true });
      const nodePath = path.join(tmpDir, 'yg-node.yaml');
      await writeFile(
        nodePath,
        `
name: PaymentService
type: service
ports:
  charge:
    description: "Synchronous payment charge"
    aspects:
      - correlation-tracking
      - idempotency
  balance:
    description: "Read-only balance check"
    aspects: []
`,
        'utf-8',
      );

      const meta = await parseNodeYaml(nodePath);
      expect(meta.ports).toEqual({
        charge: { description: 'Synchronous payment charge', aspects: ['correlation-tracking', 'idempotency'] },
        balance: { description: 'Read-only balance check', aspects: [] },
      });

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('rejects port without description', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-port-no-description');
      await mkdir(tmpDir, { recursive: true });
      const nodePath = path.join(tmpDir, 'yg-node.yaml');
      await writeFile(
        nodePath,
        `
name: Bad
type: service
ports:
  charge:
    aspects: [foo]
`,
        'utf-8',
      );

      await expect(parseNodeYaml(nodePath)).rejects.toThrow(/description/);

      await rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe('node-parser — when filter', () => {
    it('parses object form in aspects', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-when');
      await mkdir(tmpDir, { recursive: true });
      const nodeYaml = path.join(tmpDir, 'yg-node.yaml');
      await writeFile(nodeYaml, [
        'name: Handler',
        'type: command',
        'aspects:',
        '  - simple-aspect',
        '  - id: conditional-aspect',
        '    when:',
        '      relations:',
        '        calls: { target_type: service-client }',
      ].join('\n'), 'utf-8');

      const result = await parseNodeYaml(nodeYaml);
      expect(result.aspects).toEqual(['simple-aspect', 'conditional-aspect']);
      expect(result.aspectWhens).toEqual({
        'conditional-aspect': {
          relations: { calls: { target_type: 'service-client' } },
        },
      });

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('parses object form in ports.*.aspects', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-port-when');
      await mkdir(tmpDir, { recursive: true });
      const nodeYaml = path.join(tmpDir, 'yg-node.yaml');
      await writeFile(nodeYaml, [
        'name: Svc',
        'type: service',
        'ports:',
        '  charge:',
        '    description: "Charge port"',
        '    aspects:',
        '      - correlation-tracking',
        '      - id: idempotency',
        '        when:',
        '          node: { has_mapping: true }',
      ].join('\n'), 'utf-8');

      const result = await parseNodeYaml(nodeYaml);
      expect(result.ports?.charge?.aspects).toEqual(['correlation-tracking', 'idempotency']);
      expect(result.ports?.charge?.aspectWhens).toEqual({
        idempotency: { node: { has_mapping: true } },
      });

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('rejects invalid when inside aspects object form', async () => {
      const tmpDir = path.join(__dirname, '../../fixtures/tmp-node-when-bad');
      await mkdir(tmpDir, { recursive: true });
      const nodeYaml = path.join(tmpDir, 'yg-node.yaml');
      await writeFile(nodeYaml, [
        'name: X',
        'type: command',
        'aspects:',
        '  - id: a',
        '    when: { mostly_of: [] }',
      ].join('\n'), 'utf-8');

      await expect(parseNodeYaml(nodeYaml)).rejects.toThrow(/unknown when operator 'mostly_of'/);

      await rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe('node-parser: aspect status', () => {
    const TMP_STATUS = path.join(__dirname, '../../fixtures/tmp-node-status');

    async function writeNodeFixture(yaml: string): Promise<string> {
      await mkdir(TMP_STATUS, { recursive: true });
      const p = path.join(TMP_STATUS, 'yg-node.yaml');
      await writeFile(p, yaml, 'utf-8');
      return p;
    }

    afterEach(async () => {
      await rm(TMP_STATUS, { recursive: true, force: true });
    });

    it('bare string aspect → no status override', async () => {
      const p = await writeNodeFixture(`
name: Ex
type: service
aspects:
  - input-validation
`);
      const meta = await parseNodeYaml(p);
      expect(meta.aspects).toEqual(['input-validation']);
      expect(meta.aspectStatus).toBeUndefined();
    });

    it('object form with status', async () => {
      const p = await writeNodeFixture(`
name: Ex
type: service
aspects:
  - id: input-validation
    status: advisory
`);
      const meta = await parseNodeYaml(p);
      expect(meta.aspects).toEqual(['input-validation']);
      expect(meta.aspectStatus?.['input-validation']).toBe('advisory');
    });

    it('mixed: bare + object form', async () => {
      const p = await writeNodeFixture(`
name: Ex
type: service
aspects:
  - a
  - id: b
    status: draft
`);
      const meta = await parseNodeYaml(p);
      expect(meta.aspects).toEqual(['a', 'b']);
      expect(meta.aspectStatus?.['a']).toBeUndefined();
      expect(meta.aspectStatus?.['b']).toBe('draft');
    });

    it('status on port aspect', async () => {
      const p = await writeNodeFixture(`
name: Ex
type: service
ports:
  charge:
    description: Charges a card
    aspects:
      - id: correlation
        status: enforced
`);
      const meta = await parseNodeYaml(p);
      expect(meta.ports?.['charge'].aspects).toEqual(['correlation']);
      expect(meta.ports?.['charge'].aspectStatus?.['correlation']).toBe('enforced');
    });
  });
});
