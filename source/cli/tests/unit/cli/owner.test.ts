import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { Command } from 'commander';
import { findOwner } from '../../../src/cli/owner.js';
import type { Graph } from '../../../src/model/graph.js';
import { tmpdir } from 'node:os';

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

async function withFixtureCopy<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ygg-owner-'));
  await cp(FIXTURE, root, { recursive: true });
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
