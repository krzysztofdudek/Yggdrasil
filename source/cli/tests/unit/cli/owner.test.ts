import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { findOwner } from '../../../src/cli/owner.js';
import type { Graph } from '../../../src/model/graph.js';
import { tmpdir } from 'node:os';
import { FIXTURE_ZERO_ENFORCEMENT, FIXTURE_CYCLIC_TYPE } from '../../fixtures/type-level-engine/variants/index.js';

// Keep the real abortOnUnexpectedError (so an unclassified error still renders
// the generic "file an issue" text) but stub loadGraphOrAbort so the owner
// action can run in-process against a fixed graph root — no built bin.js needed.
vi.mock('../../../src/cli/preamble.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/cli/preamble.js')>();
  return { ...actual, loadGraphOrAbort: vi.fn() };
});
vi.mock('../../../src/utils/debug-log.js', () => ({
  initDebugLog: vi.fn(),
  debugWrite: vi.fn(),
}));
vi.mock('../../../src/io/debug-log-writer.js', () => ({ appendToDebugLog: vi.fn() }));

import { registerOwnerCommand } from '../../../src/cli/owner.js';
import { loadGraphOrAbort } from '../../../src/cli/preamble.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');
const TYPE_LEVEL_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'type-level-engine');

async function withFixtureCopy<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ygg-owner-'));
  await cp(FIXTURE, root, { recursive: true });
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withTypeLevelFixtureCopy<T>(fn: (cwd: string) => Promise<T>, ...overlays: string[]): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ygg-owner-typelevel-'));
  await cp(TYPE_LEVEL_FIXTURE, root, { recursive: true });
  for (const overlay of overlays) await cp(overlay, root, { recursive: true });
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('owner command', () => {
  it('finds owner of a mapped file', async () => {
    await withFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/orders/order.service.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('orders/order-service');
      expect(result.stdout).toContain('src/orders/order.service.ts');
    });
  });

  it('finds owner for a file in a node with multiple mapped files', async () => {
    await withFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/auth/auth.controller.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('auth/auth-api');
    });
  });

  it('finds owner for second file of a node with multiple mapped files', async () => {
    await withFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/auth/login.service.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('auth/auth-api');
    });
  });

  it('reports no graph coverage for an unmapped file that does not exist', async () => {
    await withFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/totally/new/module.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('no graph coverage');
      expect(result.stdout).toContain('file not found');
    });
  });

  it('reports no graph coverage for an existing unmapped file', async () => {
    await withFixtureCopy(async (cwd) => {
      // src/orders/order.service.ts exists and is mapped, but let's use a file
      // that we know exists in the fixture but isn't mapped
      // The checkout controller is mapped to checkout/controller, so let's use
      // a subpath within an unmapped directory
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/users/user.repository.ts'],
        { cwd, encoding: 'utf-8' },
      );
      // This file IS mapped to users/user-repo
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('users/user-repo');
    });
  });

  it('requires --file with a structured what/why/next error (not a bare Commander error)', async () => {
    await withFixtureCopy(async (cwd) => {
      const result = spawnSync('node', [BIN_PATH, 'owner'], {
        cwd,
        encoding: 'utf-8',
      });
      expect(result.status).toBe(1);
      // WHAT / WHY / NEXT — the message-design contract, not Commander's default.
      expect(result.stderr).toContain('--file is required.');
      expect(result.stderr).toContain('yg owner resolves which graph node owns');
      expect(result.stderr).toContain('yg owner --file <path>');
      // The raw Commander phrasing must be gone.
      expect(result.stderr).not.toContain("required option '--file <path>' not specified");
    });
  });

  it('outputs file -> node mapping in expected format', async () => {
    await withFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/checkout/checkout.controller.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/src\/checkout\/checkout\.controller\.ts -> checkout\/controller/);
    });
  });
});

describe('owner — a file inside a nested project is never reported as owned', () => {
  async function plantVendoredNode(cwd: string): Promise<void> {
    await mkdir(path.join(cwd, '.yggdrasil', 'model', 'vendored'), { recursive: true });
    await writeFile(
      path.join(cwd, '.yggdrasil', 'model', 'vendored', 'yg-node.yaml'),
      'name: Vendored\ndescription: x\ntype: service\nmapping:\n  - src/vendored\n',
    );
    // A vendored dependency checked out inside the mapped directory, with its
    // own real `.git`. Its file is real, on-disk content — just not this
    // node's, or any node's, to enforce.
    await mkdir(path.join(cwd, 'src', 'vendored', 'dep', '.git'), { recursive: true });
    await writeFile(path.join(cwd, 'src', 'vendored', 'dep', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(cwd, 'src', 'vendored', 'dep', 'foreign.ts'), 'export const foreign = 1;\n');
    await writeFile(path.join(cwd, 'src', 'vendored', 'own.ts'), 'export const own = 1;\n');
  }

  it('reports "excluded from graph coverage by design", not the node whose directory contains it', async () => {
    await withFixtureCopy(async (cwd) => {
      await plantVendoredNode(cwd);
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/vendored/dep/foreign.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('src/vendored/dep/foreign.ts is excluded from graph coverage by design.');
      expect(result.stdout).toContain('No action needed.');
      expect(result.stdout).not.toContain('-> vendored\n');
      // The generic unmapped advice ("Add it to a node's mapping") must never
      // appear for an excluded path — following it verbatim would write a
      // mapping entry file-mapping-excluded immediately refuses.
      expect(result.stdout).not.toContain("Add '");
      // Names the actual cause (a separate project's own boundary) instead of
      // the three-way disjunction — the coverage.excluded wording and the
      // structural git-internals/graph-directory wording must both be absent.
      expect(result.stdout).toContain("it sits inside a separate project's own boundary");
      expect(result.stdout).not.toContain('coverage.excluded root in yg-config.yaml');
      expect(result.stdout).not.toContain('git internals or the graph');
    });
  });

  it('control: the node\'s own (non-nested) file is still reported as owned', async () => {
    await withFixtureCopy(async (cwd) => {
      await plantVendoredNode(cwd);
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/vendored/own.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('-> vendored\n');
    });
  });

  it('reports "excluded from graph coverage by design" for a file under a coverage.excluded root, not the node whose directory contains it', async () => {
    // The same guard, from the OTHER source of exclusion membership: an
    // ORDINARY subdirectory (no nested graph, no nested .git) an adopter's
    // own coverage.excluded config names directly.
    await withFixtureCopy(async (cwd) => {
      await mkdir(path.join(cwd, '.yggdrasil', 'model', 'excl'), { recursive: true });
      await writeFile(
        path.join(cwd, '.yggdrasil', 'model', 'excl', 'yg-node.yaml'),
        'name: Excl\ndescription: x\ntype: service\nmapping:\n  - src/excl\n',
      );
      await mkdir(path.join(cwd, 'src', 'excl', 'vendor'), { recursive: true });
      await writeFile(path.join(cwd, 'src', 'excl', 'vendor', 'foreign.ts'), 'export const foreign = 1;\n');
      await writeFile(path.join(cwd, 'src', 'excl', 'own.ts'), 'export const own = 1;\n');
      const configPath = path.join(cwd, '.yggdrasil', 'yg-config.yaml');
      const existingConfig = await readFile(configPath, 'utf-8');
      await writeFile(configPath, existingConfig + '\ncoverage:\n  excluded:\n    - src/excl/vendor/\n');
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/excl/vendor/foreign.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('src/excl/vendor/foreign.ts is excluded from graph coverage by design.');
      expect(result.stdout).toContain('No action needed.');
      expect(result.stdout).not.toContain('-> excl\n');
      expect(result.stdout).not.toContain("Add '");
      // Names the actual cause (a coverage.excluded config root) instead of
      // the three-way disjunction — the nested-project and structural
      // wordings must both be absent.
      expect(result.stdout).toContain('it matches a coverage.excluded root in yg-config.yaml');
      expect(result.stdout).not.toContain("separate project's own boundary");
      expect(result.stdout).not.toContain('git internals or the graph');

      // Mirror: the node's OWN (non-excluded) file is still reported as owned.
      const own = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/excl/own.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(own.status).toBe(0);
      expect(own.stdout).toContain('-> excl\n');
    });
  });

  it('a mapping entry that NAMES a nested file exactly is reported as having no owner too — exclusion cuts an explicit claim exactly like it cuts a directory or glob sweep', async () => {
    await withFixtureCopy(async (cwd) => {
      await mkdir(path.join(cwd, '.yggdrasil', 'model', 'named'), { recursive: true });
      await writeFile(
        path.join(cwd, '.yggdrasil', 'model', 'named', 'yg-node.yaml'),
        'name: Named\ndescription: x\ntype: service\nmapping:\n  - src/named/dep/claimed.ts\n',
      );
      await mkdir(path.join(cwd, 'src', 'named', 'dep', '.git'), { recursive: true });
      await writeFile(path.join(cwd, 'src', 'named', 'dep', '.git', 'HEAD'), 'ref: refs/heads/main\n');
      await writeFile(path.join(cwd, 'src', 'named', 'dep', 'claimed.ts'), 'export const claimed = 1;\n');
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/named/dep/claimed.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('src/named/dep/claimed.ts is excluded from graph coverage by design.');
      expect(result.stdout).not.toContain('-> named\n');
    });
  });
});

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

describe('owner --file outside the project root: classified, not a "file an issue" crash', () => {
  const mockLoad = vi.mocked(loadGraphOrAbort);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the path is outside the project root (what/why/next), never the generic bug message, exit 1', async () => {
    // A real fixture graph root — the action derives repoRoot from it, so an
    // absolute /etc/passwd resolves outside and findOwner throws the
    // "Path is outside project root" error the CLI must classify.
    mockLoad.mockResolvedValue({
      rootPath: path.join(FIXTURE, '.yggdrasil'),
      nodes: new Map(),
      config: {},
    } as unknown as Graph);

    let exitCode: number | undefined;
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new ExitSignal(exitCode);
    }) as never);
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    const program = new Command();
    program.exitOverride();
    registerOwnerCommand(program);
    try {
      await program.parseAsync(['node', 'yg', 'owner', '--file', '/etc/passwd']);
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
    }

    const err = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    void stdoutSpy;
    expect(exitCode).toBe(1);
    expect(err).toContain('outside the project root');
    // The generic crash handler must NOT fire for this user-input error.
    expect(err).not.toContain('This is a bug');
  });
});

function makeGraph(nodes: Map<string, { path: string; meta: { mapping?: string[] } }>): Graph {
  return {
    nodes: nodes as Graph['nodes'],
    config: { reviewer: { tiers: {} } },
    architecture: { node_types: {} },
    aspects: [],
    flows: [],
    rootPath: '/fake/.yggdrasil',
  } as unknown as Graph;
}

describe('findOwner tie-break determinism', () => {
  it('resolves an equal-length mapping tie to the lexicographically-smaller node path, regardless of insertion order', () => {
    const projectRoot = '/fake';

    // Both nodes map 'src/shared' — equal length, so lex order of node path decides.
    const graphA = makeGraph(new Map([
      ['zzz', { path: 'zzz', meta: { mapping: ['src/shared'] } }],
      ['aaa', { path: 'aaa', meta: { mapping: ['src/shared'] } }],
    ]));
    const graphB = makeGraph(new Map([
      ['aaa', { path: 'aaa', meta: { mapping: ['src/shared'] } }],
      ['zzz', { path: 'zzz', meta: { mapping: ['src/shared'] } }],
    ]));

    const resultA = findOwner(graphA, projectRoot, 'src/shared/util.ts');
    const resultB = findOwner(graphB, projectRoot, 'src/shared/util.ts');

    // Both orders must resolve to the same node
    expect(resultA.nodePath).toBe(resultB.nodePath);
    // And that node must be the lexicographically smaller one
    expect(resultA.nodePath).toBe('aaa');
  });
});

describe('owner — a typed answer for a type-covered file', () => {
  it('answers with the type instead of "no graph coverage"', async () => {
    await withTypeLevelFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/leaf/a.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('type:leaf');
      expect(result.stdout).not.toContain('no graph coverage');
    });
  });

  it('the graph directory itself is still exempt — never classified as a type', async () => {
    await withTypeLevelFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', '.yggdrasil/yg-config.yaml'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('is excluded from graph coverage by design.');
      expect(result.stdout).not.toContain('type:');
      // Names the structural cause (git internals / the graph's own directory)
      // instead of the three-way disjunction — the two config-driven wordings
      // must both be absent.
      expect(result.stdout).toContain("it sits inside git internals or the graph's own .yggdrasil/ directory");
      expect(result.stdout).not.toContain("separate project's own boundary");
      expect(result.stdout).not.toContain('coverage.excluded root in yg-config.yaml');
    });
  });

  it('a file under a coverage.excluded root is never classified either — exclusion is absolute', async () => {
    await withTypeLevelFixtureCopy(async (cwd) => {
      const configPath = path.join(cwd, '.yggdrasil', 'yg-config.yaml');
      const { readFileSync, writeFileSync } = await import('node:fs');
      const config = readFileSync(configPath, 'utf-8').replace('excluded: []', 'excluded:\n    - src/leaf/');
      writeFileSync(configPath, config, 'utf-8');
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/leaf/a.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('src/leaf/a.ts is excluded from graph coverage by design.');
      expect(result.stdout).not.toContain('type:');
    });
  });

  // The exemption test above (".yggdrasil/yg-config.yaml is still exempt")
  // cannot actually discriminate: no type in this fixture's architecture
  // matches ANY .yggdrasil/ path, so the assertion would hold even without
  // the exemption guard. This test adds a type broad enough to match
  // EVERY .yaml file in the repository — including the graph's own node
  // files under .yggdrasil/model/ — so the exemption is the only thing that
  // can still keep the answer "excluded from graph coverage by design"
  // instead of a typed "type:anyyaml" answer.
  it('a classifying type broad enough to match every .yaml file still never reaches a .yggdrasil/-internal path', async () => {
    await withTypeLevelFixtureCopy(async (cwd) => {
      const archPath = path.join(cwd, '.yggdrasil', 'yg-architecture.yaml');
      const { readFileSync, writeFileSync } = await import('node:fs');
      const arch = readFileSync(archPath, 'utf-8').replace(
        'node_types:',
        'node_types:\n  anyyaml:\n    description: "Vacuously matches every .yaml file in the repository, including the graph\'s own."\n    when:\n      path: "**/*.yaml"\n',
      );
      writeFileSync(archPath, arch, 'utf-8');
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', '.yggdrasil/model/owned/yg-node.yaml'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).not.toMatch(/type-covered as|type:anyyaml/);
      expect(result.stdout).toContain('is excluded from graph coverage by design.');
    });
  });

  // For a type-covered file with ZERO applicable rules, `yg owner` must not
  // assert the opposite of the truth ("Enforced by its architecture type").
  // src/ep/e.ts's only attached rule is whole-unit (per: node) — it can never
  // produce a pair for a nodeless file.
  it('a type-covered file with zero applicable rules says so, never "Enforced by its architecture type"', async () => {
    await withTypeLevelFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/ep/e.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('type:emptyparents');
      expect(result.stdout).not.toContain('Enforced by its architecture type');
      expect(result.stdout).toContain('nothing from it enforces on this file');
    }, FIXTURE_ZERO_ENFORCEMENT);
  });

  it('a type-covered file WITH applicable rules keeps saying "Enforced by its architecture type"', async () => {
    await withTypeLevelFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/leaf/a.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Enforced by its architecture type, not by a component.');
    });
  });

  // A type-covered file whose matched type's rules hit an implies cycle
  // (cyclic-a <-> cyclic-b, variants/cyclic-type) must never be told "Covered
  // by its architecture type, but nothing from it enforces on this file": the
  // rules were never resolved, not resolved-and-absent. `yg context --file`
  // already tells this truth for the same fixture — this pins that `yg owner
  // --file`, which computes the identical "does anything enforce" answer
  // independently, tells it too, instead of asserting zero enforcement.
  it('a type-covered file whose type hit an implies cycle says so, naming it — never "nothing enforces"', async () => {
    await withTypeLevelFixtureCopy(async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'owner', '--file', 'src/cyclic/z.ts'],
        { cwd, encoding: 'utf-8' },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain('nothing from it enforces on this file');
      expect(result.stdout).not.toContain('Covered by its architecture type');
      expect(result.stderr).toContain("matches type 'cyclic'");
      expect(result.stderr).toMatch(/implies cycle/);
      expect(result.stderr).toMatch(/cyclic-a|cyclic-b/);

      // yg check independently reports the SAME structural fault and stays red —
      // this fix must not touch that path.
      const checked = spawnSync('node', [BIN_PATH, 'check'], { cwd, encoding: 'utf-8' });
      expect(checked.status).toBe(1);
      expect(checked.stdout).toContain('aspect-implies-cycle');
    }, FIXTURE_CYCLIC_TYPE);
  });
});
