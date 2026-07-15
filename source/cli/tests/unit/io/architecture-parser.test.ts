import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseArchitecture } from '../../../src/io/architecture-parser.js';

describe('parseArchitecture', () => {
  const dirsToCleanup: string[] = [];
  afterEach(async () => {
    for (const d of dirsToCleanup.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function writeTmp(fileName: string, content: string): Promise<string> {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'yg-arch-'));
    dirsToCleanup.push(tmpDir);
    const file = path.join(tmpDir, fileName);
    await writeFile(file, content, 'utf-8');
    return file;
  }

  async function cleanup(file: string): Promise<void> {
    const dir = path.dirname(file);
    await rm(dir, { recursive: true, force: true });
  }

  it('parses minimal architecture with only descriptions', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  module:
    description: "Business logic unit"
  service:
    description: "Request handler"
`);
    const arch = await parseArchitecture(file);
    expect(arch.node_types.module.description).toBe('Business logic unit');
    expect(arch.node_types.service.description).toBe('Request handler');
    expect(arch.node_types.module.aspects).toBeUndefined();
    await cleanup(file);
  });

  it('parses full architecture with all constraints', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "Request handler"
    aspects: [requires-auth, error-format]
    parents: [module]
    relations:
      calls: [service, library]
      uses: [library]
`);
    const arch = await parseArchitecture(file);
    const svc = arch.node_types.service;
    expect(svc.aspects).toEqual(['requires-auth', 'error-format']);
    expect(svc.parents).toEqual(['module']);
    expect(svc.relations?.calls).toEqual(['service', 'library']);
    expect(svc.relations?.uses).toEqual(['library']);
    await cleanup(file);
  });

  it('accepts file with no node_types field as empty', async () => {
    const file = await writeTmp('yg-architecture.yaml', `name: test`);
    const arch = await parseArchitecture(file);
    expect(arch.node_types).toEqual({});
    await cleanup(file);
  });

  it('throws on missing description', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    aspects: [foo]
`);
    await expect(parseArchitecture(file)).rejects.toThrow('description');
    await cleanup(file);
  });

  it('throws on invalid relation type', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "test"
    relations:
      depends: [library]
`);
    await expect(parseArchitecture(file)).rejects.toThrow('relation type');
    await cleanup(file);
  });

  it('parses all valid relation types', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "test"
    relations:
      uses: [library]
      calls: [service]
      extends: [base]
      implements: [interface]
      emits: [event]
      listens: [event]
`);
    const arch = await parseArchitecture(file);
    const rels = arch.node_types.service.relations;
    expect(rels?.uses).toEqual(['library']);
    expect(rels?.calls).toEqual(['service']);
    expect(rels?.extends).toEqual(['base']);
    expect(rels?.implements).toEqual(['interface']);
    expect(rels?.emits).toEqual(['event']);
    expect(rels?.listens).toEqual(['event']);
    await cleanup(file);
  });

  it('parses empty relations object', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "test"
    relations: {}
`);
    const arch = await parseArchitecture(file);
    const rels = arch.node_types.service.relations;
    expect(rels).toEqual({});
    await cleanup(file);
  });

  it('throws on non-array relation value', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "test"
    relations:
      uses: "library"
`);
    await expect(parseArchitecture(file)).rejects.toThrow('array');
    await cleanup(file);
  });

  it('throws when relation targets mix strings and non-strings (no silent drop)', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "test"
    relations:
      calls: [service, 42, library]
`);
    // The middle target (42) must NOT be silently dropped — fail loud naming
    // the field and the offending value at its index.
    const err = await parseArchitecture(file).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/relations\.calls.*contains non-string entry/);
    expect(err?.message).toContain('index 1');
    expect(err?.message).toContain('42');
    await cleanup(file);
  });

  it('throws when parents array mixes strings and non-strings (no silent drop)', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "test"
    parents: [module, 7, root]
`);
    const err = await parseArchitecture(file).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/parents.*contains non-string entry/);
    expect(err?.message).toContain('index 1');
    expect(err?.message).toContain('7');
    await cleanup(file);
  });

  it('parses all-string parents and relation targets unchanged (control)', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "test"
    parents: [module, root]
    relations:
      calls: [service, library]
`);
    const arch = await parseArchitecture(file);
    expect(arch.node_types.service.parents).toEqual(['module', 'root']);
    expect(arch.node_types.service.relations?.calls).toEqual(['service', 'library']);
    await cleanup(file);
  });

  it('accepts empty file as empty node_types', async () => {
    const file = await writeTmp('yg-architecture.yaml', '');
    const arch = await parseArchitecture(file);
    expect(arch.node_types).toEqual({});
    await cleanup(file);
  });

  it('accepts empty node_types object', async () => {
    const file = await writeTmp('yg-architecture.yaml', 'node_types: {}\n');
    const arch = await parseArchitecture(file);
    expect(arch.node_types).toEqual({});
    await cleanup(file);
  });

  it('accepts null node_types value', async () => {
    const file = await writeTmp('yg-architecture.yaml', 'node_types:\n');
    const arch = await parseArchitecture(file);
    expect(arch.node_types).toEqual({});
    await cleanup(file);
  });

  it('accepts commented-only architecture file', async () => {
    const file = await writeTmp('yg-architecture.yaml', '# commented placeholder\n');
    const arch = await parseArchitecture(file);
    expect(arch.node_types).toEqual({});
    await cleanup(file);
  });

  it('rejects top-level YAML array', async () => {
    const file = await writeTmp('yg-architecture.yaml', '- foo\n- bar\n');
    await expect(parseArchitecture(file)).rejects.toThrow(/mapping/);
    await cleanup(file);
  });

  it('rejects node_types as array', async () => {
    const file = await writeTmp('yg-architecture.yaml', 'node_types:\n  - service\n');
    await expect(parseArchitecture(file)).rejects.toThrow(/mapping/);
    await cleanup(file);
  });

  it('allows node_types with only description (minimal valid entry)', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  module:
    description: "unit"
  service:
    description: "handler"
  library:
    description: "utility"
`);
    const arch = await parseArchitecture(file);
    expect(Object.keys(arch.node_types)).toHaveLength(3);
    expect(arch.node_types.module.description).toBe('unit');
    expect(arch.node_types.service.description).toBe('handler');
    expect(arch.node_types.library.description).toBe('utility');
    await cleanup(file);
  });

  it('parses object form in node_types.*.aspects with when', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  command:
    description: "A command"
    aspects:
      - simple-aspect
      - id: conditional-aspect
        when:
          relations: { calls: { target_type: service-client } }
`);
    const result = await parseArchitecture(file);
    expect(result.node_types.command.aspects).toEqual(['simple-aspect', 'conditional-aspect']);
    expect(result.node_types.command.aspectWhens).toEqual({
      'conditional-aspect': { relations: { calls: { target_type: 'service-client' } } },
    });
    await cleanup(file);
  });

  it('preserves an empty relation list (does not drop it)', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "test"
    relations:
      uses: []
`);
    const arch = await parseArchitecture(file);
    expect(arch.node_types.service.relations?.uses).toEqual([]);
    await cleanup(file);
  });

  it('parses relations.default scalar (allow/deny) into relationDefault', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  sink:
    description: "test"
    relations:
      default: deny
  open:
    description: "test"
    relations:
      default: allow
`);
    const arch = await parseArchitecture(file);
    expect(arch.node_types.sink.relationDefault).toBe('deny');
    expect(arch.node_types.open.relationDefault).toBe('allow');
    await cleanup(file);
  });

  it('leaves relationDefault undefined when no default key is present', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "test"
    relations:
      uses: [domain]
`);
    const arch = await parseArchitecture(file);
    expect(arch.node_types.service.relationDefault).toBeUndefined();
    expect(arch.node_types.service.relations?.uses).toEqual(['domain']);
    await cleanup(file);
  });

  it('throws on an invalid relations.default value', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "test"
    relations:
      default: maybe
`);
    await expect(parseArchitecture(file)).rejects.toThrow(/relations\.default must be 'allow' or 'deny'/);
    await cleanup(file);
  });

  it('does not treat the default key as an unknown relation type', async () => {
    const file = await writeTmp('yg-architecture.yaml', `
node_types:
  sink:
    description: "test"
    relations:
      default: deny
      listens: ['*']
`);
    const arch = await parseArchitecture(file);
    expect(arch.node_types.sink.relationDefault).toBe('deny');
    expect(arch.node_types.sink.relations?.listens).toEqual(['*']);
    await cleanup(file);
  });

  describe('architecture-parser v4 changes', () => {
    it('rejects integration_aspects as unknown field', async () => {
      const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "Request handler"
    aspects: [requires-auth]
    integration_aspects: [correlation-tracking]
`);
      await expect(parseArchitecture(file)).rejects.toThrow(/unknown field.*integration_aspects/i);
      await cleanup(file);
    });

    it('parses architecture without integration_aspects', async () => {
      const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "Request handler"
    aspects: [requires-auth]
    parents: [module]
`);
      const arch = await parseArchitecture(file);
      expect(arch.node_types.service.aspects).toEqual(['requires-auth']);
      expect(arch.node_types.service).not.toHaveProperty('integration_aspects');
      await cleanup(file);
    });

    it('rejects an unknown node_type key (typo of a real field)', async () => {
      // 'parent' (singular) is a typo of 'parents' — silently ignored before,
      // dropping the intended hierarchy constraint. Now a blocking parse error.
      const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "Request handler"
    parent: [module]
`);
      await expect(parseArchitecture(file)).rejects.toThrow(/unknown key 'parent'/i);
      await cleanup(file);
    });

    it('lists every unknown node_type key when several are present', async () => {
      const file = await writeTmp('yg-architecture.yaml', `
node_types:
  service:
    description: "Request handler"
    aspect: [requires-auth]
    relation: {}
`);
      await expect(parseArchitecture(file)).rejects.toThrow(/unknown keys 'aspect', 'relation'/i);
      await cleanup(file);
    });
  });
});

describe('parseArchitecture — log_required', () => {
  async function withArchYaml<T>(yaml: string, fn: (filePath: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), 'yg-arch-'));
    try {
      const filePath = path.join(dir, 'yg-architecture.yaml');
      await writeFile(filePath, yaml, 'utf-8');
      return await fn(filePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('reads log_required: true', async () => {
    const yaml = `node_types:\n  command:\n    description: CLI command handler\n    log_required: true\n`;
    await withArchYaml(yaml, async (fp) => {
      const arch = await parseArchitecture(fp);
      expect(arch.node_types.command.log_required).toBe(true);
    });
  });

  it('reads log_required: false', async () => {
    const yaml = `node_types:\n  test:\n    description: Test fixtures\n    log_required: false\n`;
    await withArchYaml(yaml, async (fp) => {
      const arch = await parseArchitecture(fp);
      expect(arch.node_types.test.log_required).toBe(false);
    });
  });

  it('leaves log_required undefined when field absent', async () => {
    const yaml = `node_types:\n  module:\n    description: Module\n`;
    await withArchYaml(yaml, async (fp) => {
      const arch = await parseArchitecture(fp);
      expect(arch.node_types.module.log_required).toBeUndefined();
    });
  });

  it('rejects log_required when not boolean', async () => {
    const yaml = `node_types:\n  module:\n    description: Module\n    log_required: "yes"\n`;
    await withArchYaml(yaml, async (fp) => {
      await expect(parseArchitecture(fp)).rejects.toThrow(/log_required.*boolean/);
    });
  });
});

describe('parseArchitecture — when and enforce', () => {
  async function withArchYaml<T>(yaml: string, fn: (filePath: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), 'yg-arch-'));
    try {
      const filePath = path.join(dir, 'yg-architecture.yaml');
      await writeFile(filePath, yaml, 'utf-8');
      return await fn(filePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('parses when on node_type', async () => {
    const yaml = `node_types:
  command:
    description: "CLI command"
    when:
      all_of:
        - path: "src/cli/**/*.ts"
        - content: "register[A-Z]\\\\w*Command"
`;
    await withArchYaml(yaml, async (fp) => {
      const result = await parseArchitecture(fp);
      expect(result.node_types.command.when).toEqual({
        all_of: [{ path: 'src/cli/**/*.ts' }, { content: 'register[A-Z]\\w*Command' }],
      });
    });
  });

  it('parses enforce: strict on node_type', async () => {
    const yaml = `node_types:
  command:
    description: "CLI command"
    when:
      path: "**"
    enforce: strict
`;
    await withArchYaml(yaml, async (fp) => {
      const result = await parseArchitecture(fp);
      expect(result.node_types.command.enforce).toBe('strict');
    });
  });

  it("rejects enforce values other than 'strict'", async () => {
    const yaml = `node_types:
  command:
    description: "CLI command"
    when:
      path: "**"
    enforce: relaxed
`;
    await withArchYaml(yaml, async (fp) => {
      await expect(parseArchitecture(fp)).rejects.toThrow(/enforce must be 'strict'/);
    });
  });

  it('allows type without when (organizational)', async () => {
    const yaml = `node_types:
  module:
    description: "Grouping node"
`;
    await withArchYaml(yaml, async (fp) => {
      const result = await parseArchitecture(fp);
      expect(result.node_types.module.when).toBeUndefined();
      expect(result.node_types.module.description).toBe('Grouping node');
    });
  });

  it('propagates WhenPredicateInvalidError for malformed when', async () => {
    const yaml = `node_types:
  command:
    description: "CLI command"
    when:
      foo: bar
`;
    await withArchYaml(yaml, async (fp) => {
      await expect(parseArchitecture(fp)).rejects.toThrow(/unknown.*key.*foo/);
    });
  });

  it("throws when a node type is named '*' (reserved wildcard token)", async () => {
    const yaml = `node_types:\n  '*':\n    description: "This name is reserved"\n`;
    await withArchYaml(yaml, async (fp) => {
      await expect(parseArchitecture(fp)).rejects.toThrow(/node type name '\*' is reserved/);
    });
  });

  it('node: atom in node_types.X.when → error mentions "node_types.*.when" and not "scope.files"', async () => {
    const yaml = `node_types:
  command:
    description: "CLI command"
    when:
      node:
        type: service
`;
    await withArchYaml(yaml, async (fp) => {
      const err = await parseArchitecture(fp).then(() => null, (e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toMatch(/node_types\.\*\.when/);
      expect(err?.message).not.toContain('scope.files');
    });
  });
});
