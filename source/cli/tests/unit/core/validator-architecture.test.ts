import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { validate } from '../../../src/core/validator.js';
import { loadGraph } from '../../../src/core/graph-loader.js';
import type { Graph, GraphNode } from '../../../src/model/graph.js';
import { parseArchitecture } from '../../../src/io/architecture-parser.js';
import { checkArchitectureRelations } from '../../../src/core/checks/architecture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(__dirname, '../../fixtures/sample-project');
const CLI_ROOT = path.join(__dirname, '../../../..');

function createNode(nodePath: string, overrides: Partial<GraphNode['meta']> = {}): GraphNode {
  const name = nodePath.split('/').pop() ?? nodePath;
  return {
    path: nodePath,
    meta: {
      name,
      type: 'service',
      ...overrides,
    },
    children: [],
    parent: null,
  };
}

function createGraph(overrides: Partial<Graph> = {}): Graph {
  return {
    config: {},
    architecture: { node_types: {} },
    nodes: new Map(),
    aspects: [{ name: 'Valid', id: 'valid-tag', reviewer: { type: 'llm' as const }, artifacts: [] }],
    flows: [],
    rootPath: path.join(FIXTURE_PROJECT, '.yggdrasil'),
    ...overrides,
  };
}

describe('checkTypeWithoutWhenWithMapping', () => {
  it('emits error when node of type without when has non-empty mapping', async () => {
    const node = createNode('foo/bar', { type: 'module', mapping: ['src/foo.ts'] });
    const graph = createGraph({
      architecture: { node_types: { module: { description: 'Grouping' } } },
      nodes: new Map([['foo/bar', node]]),
    });
    const result = await validate(graph);
    const offending = result.issues.find((i) => i.code === 'type-without-when-with-mapping');
    expect(offending).toBeDefined();
    expect(offending?.nodePath).toBe('foo/bar');
  });

  it('does not emit when node of type without when has empty mapping', async () => {
    const node = createNode('foo/bar', { type: 'module', mapping: [] });
    const graph = createGraph({
      architecture: { node_types: { module: { description: 'Grouping' } } },
      nodes: new Map([['foo/bar', node]]),
    });
    const result = await validate(graph);
    expect(result.issues.find((i) => i.code === 'type-without-when-with-mapping')).toBeUndefined();
  });

  it('does not emit when node of type with when has mapping', async () => {
    const node = createNode('foo/bar', { type: 'command', mapping: ['src/foo.ts'] });
    const graph = createGraph({
      architecture: {
        node_types: { command: { description: 'CLI', when: { path: '**' } } },
      },
      nodes: new Map([['foo/bar', node]]),
    });
    const result = await validate(graph);
    expect(result.issues.find((i) => i.code === 'type-without-when-with-mapping')).toBeUndefined();
  });
});

describe('validator — pipeline short-circuit', () => {
  it('short-circuits per-node and global stages on architecture-level error', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          a: { description: 'A', parents: ['nonexistent_type'] },
        },
      },
    });
    const result = await validate(graph);
    const codes = new Set(result.issues.map((i) => i.code));
    expect(codes.has('type-unknown-parent')).toBe(true);
    expect(codes.has('type-when-mismatch')).toBe(false);
    expect(codes.has('type-strict-orphan')).toBe(false);
  });

  it('description-missing on aspect fires even when architecture has fatal error', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          a: { description: 'A', parents: ['nonexistent_type'] },
        },
      },
      aspects: [{ name: 'broken-aspect', id: 'broken-aspect', reviewer: { type: 'llm' as const }, artifacts: [] }],
    });
    const result = await validate(graph);
    const codes = new Set(result.issues.map((i) => i.code));
    expect(codes.has('type-unknown-parent')).toBe(true);
    expect(codes.has('description-missing')).toBe(true);
  });

  it('returns architecture-invalid for string architectureError', async () => {
    const graph = createGraph({ architectureError: { code: 'architecture-invalid', messageData: { what: 'yg-architecture.yaml: bad syntax', why: 'yg-architecture.yaml failed to parse. No architecture-level rules can be checked until this is fixed.', next: 'Fix the YAML syntax in yg-architecture.yaml. Run yg check again to verify.' } } });
    const result = await validate(graph);
    expect(result.nodesScanned).toBe(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('architecture-invalid');
  });

  it('returns when-predicate-invalid for structured architectureError', async () => {
    const graph = createGraph({
      architectureError: { code: 'when-predicate-invalid', messageData: { what: 'unknown key: foo', why: 'The when: predicate in yg-architecture.yaml could not be parsed.', next: 'Fix the when: predicate syntax.' } },
    });
    const result = await validate(graph);
    expect(result.nodesScanned).toBe(0);
    expect(result.issues[0].code).toBe('when-predicate-invalid');
  });

  it('does not short-circuit when all parent types exist', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          module: { description: 'Module' },
          service: { description: 'Service', parents: ['module'] },
        },
      },
    });
    const result = await validate(graph);
    const codes = new Set(result.issues.map((i) => i.code));
    expect(codes.has('type-unknown-parent')).toBe(false);
    expect(result.nodesScanned).toBeGreaterThanOrEqual(0);
  });
});

describe('checkArchitectureParentCycles', () => {
  it('emits error for unresolvable cycle (a→b→a)', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          a: { description: 'A', parents: ['b'] },
          b: { description: 'B', parents: ['a'] },
        },
      },
    });
    const result = await validate(graph);
    expect(result.issues.find((i) => i.code === 'architecture-cycle')).toBeDefined();
  });

  it('allows self-loop with alternative parent (escape path exists)', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          module: { description: 'Mod', parents: ['module', 'root'] },
          root: { description: 'Root' },
        },
      },
    });
    const result = await validate(graph);
    expect(result.issues.find((i) => i.code === 'architecture-cycle')).toBeUndefined();
  });

  it('emits error for self-loop without alternative parent', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          module: { description: 'Mod', parents: ['module'] },
        },
      },
    });
    const result = await validate(graph);
    expect(result.issues.find((i) => i.code === 'architecture-cycle')).toBeDefined();
  });

  it('allows three-way chain with rootable end', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          a: { description: 'A', parents: ['b'] },
          b: { description: 'B', parents: ['a', 'c'] },
          c: { description: 'C' },
        },
      },
    });
    const result = await validate(graph);
    expect(result.issues.find((i) => i.code === 'architecture-cycle')).toBeUndefined();
  });
});

describe('checkEnforceStrictWithoutWhen', () => {
  it('emits error when type has enforce: strict without when', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          command: { description: 'CLI', enforce: 'strict' },
        },
      },
    });
    const result = await validate(graph);
    expect(result.issues.find((i) => i.code === 'enforce-strict-without-when')).toBeDefined();
  });

  it('does not emit when enforce: strict has when', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          command: { description: 'CLI', enforce: 'strict', when: { path: '**' } },
        },
      },
    });
    const result = await validate(graph);
    expect(result.issues.find((i) => i.code === 'enforce-strict-without-when')).toBeUndefined();
  });
});

describe('checkTypeWhenMismatch', () => {
  it('emits type-when-mismatch when file does not satisfy type when predicate', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-when-mismatch');
    try {
      const yggDir = path.join(tmpDir, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'svc'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await writeFile(path.join(tmpDir, 'src', 'handler.ts'), 'export function handler() {}');
      await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "5.2.0"\n');
      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      content: "@Injectable"',
      ].join('\n'));
      await writeFile(path.join(yggDir, 'model', 'svc', 'yg-node.yaml'), [
        'name: svc',
        'type: service',
        'description: x',
        'mapping:',
        '  - src/handler.ts',
      ].join('\n'));
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'type-when-mismatch')).toBeDefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not emit type-when-mismatch when file satisfies type when predicate', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-when-match');
    try {
      const yggDir = path.join(tmpDir, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'svc'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await writeFile(path.join(tmpDir, 'src', 'handler.ts'), '@Injectable()\nexport class SvcService {}');
      await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "5.2.0"\n');
      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      content: "@Injectable"',
      ].join('\n'));
      await writeFile(path.join(yggDir, 'model', 'svc', 'yg-node.yaml'), [
        'name: svc',
        'type: service',
        'description: x',
        'mapping:',
        '  - src/handler.ts',
      ].join('\n'));
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'type-when-mismatch')).toBeUndefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not emit type-when-mismatch when type has no when predicate', async () => {
    const graph = createGraph({
      architecture: {
        node_types: {
          module: { description: 'Module' },
        },
      },
    });
    const result = await validate(graph);
    expect(result.issues.find((i) => i.code === 'type-when-mismatch')).toBeUndefined();
  });

  it('emits file-unreadable (not type-when-mismatch) when content predicate cannot read file', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-file-unreadable');
    try {
      const yggDir = path.join(tmpDir, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'svc'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "5.2.0"\n');
      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      content: "@Injectable"',
      ].join('\n'));
      await writeFile(path.join(yggDir, 'model', 'svc', 'yg-node.yaml'), [
        'name: svc',
        'type: service',
        'description: x',
        'mapping:',
        '  - src/ghost.ts',
      ].join('\n'));
      // src/ghost.ts intentionally NOT created — stat() fails → unreadable
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const codes = new Set(result.issues.map((i) => i.code));
      expect(codes.has('file-unreadable')).toBe(true);
      expect(codes.has('type-when-mismatch')).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('checkFileMappingGitignored', () => {
  it('emits error for gitignored file in mapping', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-gitignored');
    try {
      const yggDir = path.join(tmpDir, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'svc'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await writeFile(path.join(tmpDir, '.gitignore'), 'src/generated.ts\n');
      await writeFile(path.join(tmpDir, 'src', 'generated.ts'), 'export const x = 1;');
      await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "5.2.0"\n');
      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      path: "**"',
      ].join('\n'));
      await writeFile(path.join(yggDir, 'model', 'svc', 'yg-node.yaml'), [
        'name: svc',
        'type: service',
        'description: x',
        'mapping:',
        '  - src/generated.ts',
      ].join('\n'));
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'file-mapping-gitignored')).toBeDefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('emits error for cascading-gitignored file', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-cascading-gitignored');
    try {
      const yggDir = path.join(tmpDir, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'svc'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src', 'sub'), { recursive: true });
      await writeFile(path.join(tmpDir, 'src', 'sub', '.gitignore'), 'local.ts\n');
      await writeFile(path.join(tmpDir, 'src', 'sub', 'local.ts'), 'export const y = 2;');
      await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "5.2.0"\n');
      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      path: "**"',
      ].join('\n'));
      await writeFile(path.join(yggDir, 'model', 'svc', 'yg-node.yaml'), [
        'name: svc',
        'type: service',
        'description: x',
        'mapping:',
        '  - src/sub/local.ts',
      ].join('\n'));
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'file-mapping-gitignored')).toBeDefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not emit for non-gitignored file', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-not-gitignored');
    try {
      const yggDir = path.join(tmpDir, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'svc'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await writeFile(path.join(tmpDir, 'src', 'handler.ts'), 'export function handle() {}');
      await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "5.2.0"\n');
      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      path: "**"',
      ].join('\n'));
      await writeFile(path.join(yggDir, 'model', 'svc', 'yg-node.yaml'), [
        'name: svc',
        'type: service',
        'description: x',
        'mapping:',
        '  - src/handler.ts',
      ].join('\n'));
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'file-mapping-gitignored')).toBeUndefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not emit for a tracked file mapped with a leading "./" prefix', async () => {
    // A mapping entry may carry a no-op './' prefix. walkRepoFiles emits clean
    // POSIX paths (no './'), so an unnormalized membership test would miss the
    // tracked file and falsely flag a correctly-tracked, non-gitignored file as
    // gitignored. The check must normalize the entry before the tracked-set test.
    const tmpDir = path.join(CLI_ROOT, '.temp-test-dotslash-mapping');
    try {
      const yggDir = path.join(tmpDir, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'svc'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await writeFile(path.join(tmpDir, 'src', 'handler.ts'), 'export function handle() {}');
      await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "5.2.0"\n');
      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      path: "**"',
      ].join('\n'));
      await writeFile(path.join(yggDir, 'model', 'svc', 'yg-node.yaml'), [
        'name: svc',
        'type: service',
        'description: x',
        'mapping:',
        '  - ./src/handler.ts',
      ].join('\n'));
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'file-mapping-gitignored')).toBeUndefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not emit for a LITERAL .yggdrasil/ file mapping (meta-modeling)', async () => {
    // A committed rule file under .yggdrasil/ is skipped by walkRepoFiles for
    // STRUCTURAL reasons (the graph's own directory), not because it is gitignored.
    // Meta-modeling explicitly allows mapping such a file by its literal path, so the
    // gitignored check must exempt it — otherwise `yg check` blocks the very mapping
    // the docs instruct authors to write.
    const tmpDir = path.join(CLI_ROOT, '.temp-test-metamodel-literal');
    try {
      const yggDir = path.join(tmpDir, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'enforcers'), { recursive: true });
      await mkdir(path.join(yggDir, 'aspects', 'no-foo'), { recursive: true });
      await writeFile(path.join(yggDir, 'aspects', 'no-foo', 'check.mjs'), 'export function check() { return []; }\n');
      await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "5.2.0"\n');
      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  service:',
        '    description: Service',
        '    when:',
        '      path: "**"',
      ].join('\n'));
      await writeFile(path.join(yggDir, 'model', 'enforcers', 'yg-node.yaml'), [
        'name: enforcers',
        'type: service',
        'description: x',
        'mapping:',
        '  - .yggdrasil/aspects/no-foo/check.mjs',
      ].join('\n'));
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'file-mapping-gitignored')).toBeUndefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('checkStrictBackwardCoverage', () => {
  async function makeStrictGraph(tmpDir: string, opts: {
    fileContent: string;
    mappedTo?: { type: string; nodePath: string };
  }) {
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(path.join(yggDir, 'model', 'svc'), { recursive: true });
    await mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await writeFile(path.join(tmpDir, 'src', 'handler.ts'), opts.fileContent);
    await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "5.2.0"\n');
    const archLines = [
      'node_types:',
      '  command:',
      '    description: Command',
      '    enforce: strict',
      '    when:',
      '      content: "registerCommand"',
    ];
    if (opts.mappedTo) {
      archLines.push(...[
        '  utility:',
        '    description: Utility',
        '    when:',
        '      path: "**"',
      ]);
    }
    await writeFile(path.join(yggDir, 'yg-architecture.yaml'), archLines.join('\n'));
    if (opts.mappedTo) {
      await mkdir(path.join(yggDir, 'model', opts.mappedTo.nodePath.split('/')[0], opts.mappedTo.nodePath.split('/').slice(1).join('/')), { recursive: true }).catch(() => {});
      await mkdir(path.join(yggDir, 'model', ...opts.mappedTo.nodePath.split('/')), { recursive: true });
      await writeFile(path.join(yggDir, 'model', ...opts.mappedTo.nodePath.split('/'), 'yg-node.yaml'), [
        `name: ${opts.mappedTo.nodePath.split('/').pop()}`,
        `type: ${opts.mappedTo.type}`,
        'description: x',
        'mapping:',
        '  - src/handler.ts',
      ].join('\n'));
    }
    return loadGraph(tmpDir);
  }

  it('emits type-strict-orphan for matching file not in any mapping', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-strict-orphan');
    try {
      const graph = await makeStrictGraph(tmpDir, { fileContent: 'registerCommand("foo");' });
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'type-strict-orphan')).toBeDefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('emits type-strict-misplaced when matching file mapped to wrong type', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-strict-misplaced');
    try {
      const graph = await makeStrictGraph(tmpDir, {
        fileContent: 'registerCommand("bar");',
        mappedTo: { type: 'utility', nodePath: 'util' },
      });
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'type-strict-misplaced')).toBeDefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not emit when matching file is in correct strict-type node', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-strict-ok');
    try {
      const yggDir = path.join(tmpDir, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'cmd'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await writeFile(path.join(tmpDir, 'src', 'handler.ts'), 'registerCommand("baz");');
      await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "5.2.0"\n');
      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  command:',
        '    description: Command',
        '    enforce: strict',
        '    when:',
        '      content: "registerCommand"',
      ].join('\n'));
      await writeFile(path.join(yggDir, 'model', 'cmd', 'yg-node.yaml'), [
        'name: cmd',
        'type: command',
        'description: x',
        'mapping:',
        '  - src/handler.ts',
      ].join('\n'));
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'type-strict-orphan')).toBeUndefined();
      expect(result.issues.find((i) => i.code === 'type-strict-misplaced')).toBeUndefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('checkStrictOverlapConflict', () => {
  async function makeOverlapGraph(tmpDir: string, typeCount: number) {
    const yggDir = path.join(tmpDir, '.yggdrasil');
    await mkdir(path.join(yggDir, 'model', 'dummy'), { recursive: true });
    await mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await writeFile(path.join(tmpDir, 'src', 'foo.ts'), 'anything', 'utf-8');
    await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "5.2.0"\n');
    const lines = ['node_types:'];
    for (let i = 0; i < typeCount; i++) {
      lines.push(`  type${i}:`, '    description: x', '    enforce: strict', '    when:', '      path: "**"');
    }
    await writeFile(path.join(yggDir, 'yg-architecture.yaml'), lines.join('\n'));
    await writeFile(path.join(yggDir, 'model', 'dummy', 'yg-node.yaml'), [
      'name: dummy', 'type: type0', 'description: x',
    ].join('\n'));
    return loadGraph(tmpDir);
  }

  it('emits strict-overlap-conflict when two strict types match same file', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-strict-overlap-2');
    try {
      const graph = await makeOverlapGraph(tmpDir, 2);
      const result = await validate(graph);
      expect(result.issues.find((i) => i.code === 'strict-overlap-conflict')).toBeDefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('emits N-choose-2 pairs when 3 strict types all overlap', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-strict-overlap-3');
    try {
      const graph = await makeOverlapGraph(tmpDir, 3);
      const result = await validate(graph);
      const conflicts = result.issues.filter((i) => i.code === 'strict-overlap-conflict');
      expect(conflicts.length).toBe(3);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('emits one error per pair not per file (deduplication)', async () => {
    const tmpDir = path.join(CLI_ROOT, '.temp-test-strict-overlap-dedup');
    try {
      const yggDir = path.join(tmpDir, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'dummy'), { recursive: true });
      await mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await writeFile(path.join(tmpDir, 'src', 'a.ts'), 'aaa', 'utf-8');
      await writeFile(path.join(tmpDir, 'src', 'b.ts'), 'bbb', 'utf-8');
      await writeFile(path.join(yggDir, 'yg-config.yaml'), 'version: "5.2.0"\n');
      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  typeA:', '    description: x', '    enforce: strict', '    when:', '      path: "**"',
        '  typeB:', '    description: y', '    enforce: strict', '    when:', '      path: "**"',
      ].join('\n'));
      await writeFile(path.join(yggDir, 'model', 'dummy', 'yg-node.yaml'), [
        'name: dummy', 'type: typeA', 'description: x',
      ].join('\n'));
      const graph = await loadGraph(tmpDir);
      const result = await validate(graph);
      const conflicts = result.issues.filter((i) => i.code === 'strict-overlap-conflict');
      // 2 files both match same pair (typeA, typeB) → exactly 1 conflict error, not 2
      expect(conflicts.length).toBe(1);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('checkArchitectureRelations — default policy, empty list, wildcard', () => {
  const tmps: string[] = [];
  afterEach(async () => {
    for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function archFrom(yaml: string) {
    const dir = await mkdtemp(path.join(tmpdir(), 'yg-arch-'));
    tmps.push(dir);
    const file = path.join(dir, 'yg-architecture.yaml');
    await writeFile(file, yaml, 'utf-8');
    return parseArchitecture(file);
  }
  // node `from` (type S) declares one relation `relType` → node `to` (type T)
  function graphWith(architecture: any, S: string, relType: string, T: string) {
    const nodes = new Map<string, any>([
      ['from', { path: 'from', meta: { type: S, relations: [{ target: 'to', type: relType }] } }],
      ['to', { path: 'to', meta: { type: T } }],
    ]);
    return { config: {}, architecture, nodes, aspects: [], flows: [], rootPath: '/x' } as any;
  }

  it('default: deny rejects an unlisted relation type to any target', async () => {
    const arch = await archFrom(`
node_types:
  sink: { description: "s", relations: { default: deny } }
  other: { description: "o" }
`);
    const issues = checkArchitectureRelations(graphWith(arch, 'sink', 'uses', 'other'));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('relation-target-forbidden');
    expect(issues[0].messageData?.why).toMatch(/denies relation 'uses' by default/);
  });

  it('default: deny + listens: ["*"] allows listens to any target', async () => {
    const arch = await archFrom(`
node_types:
  sink: { description: "s", relations: { default: deny, listens: ['*'] } }
  other: { description: "o" }
`);
    expect(checkArchitectureRelations(graphWith(arch, 'sink', 'listens', 'other'))).toHaveLength(0);
  });

  it('explicit empty list [] denies that relation type', async () => {
    const arch = await archFrom(`
node_types:
  svc: { description: "s", relations: { uses: [] } }
  other: { description: "o" }
`);
    const issues = checkArchitectureRelations(graphWith(arch, 'svc', 'uses', 'other'));
    expect(issues).toHaveLength(1);
    expect(issues[0].messageData?.why).toMatch(/Allowed targets for 'uses'/);
  });

  it('wildcard ["*"] in an explicit list allows any target', async () => {
    const arch = await archFrom(`
node_types:
  svc: { description: "s", relations: { uses: ['*'] } }
  other: { description: "o" }
`);
    expect(checkArchitectureRelations(graphWith(arch, 'svc', 'uses', 'other'))).toHaveLength(0);
  });

  it('omitted default keeps unlisted relation types unconstrained (regression)', async () => {
    const arch = await archFrom(`
node_types:
  svc: { description: "s", relations: { uses: [domain] } }
  other: { description: "o" }
`);
    // `calls` is unlisted, default omitted ⇒ allow
    expect(checkArchitectureRelations(graphWith(arch, 'svc', 'calls', 'other'))).toHaveLength(0);
  });

  it('listed non-empty list still rejects a forbidden target (regression)', async () => {
    const arch = await archFrom(`
node_types:
  svc: { description: "s", relations: { uses: [domain] } }
  other: { description: "o" }
`);
    expect(checkArchitectureRelations(graphWith(arch, 'svc', 'uses', 'other'))).toHaveLength(1);
  });

  it('non-empty explicit list: target type IS listed → allowed (positive path)', async () => {
    const arch = await archFrom(`
node_types:
  svc: { description: "s", relations: { uses: [domain] } }
  domain: { description: "d" }
`);
    // svc uses domain → domain IS in the uses list → 0 issues
    expect(checkArchitectureRelations(graphWith(arch, 'svc', 'uses', 'domain'))).toHaveLength(0);
  });
});
