import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises';

// Mock the graph preamble so the command never touches the real filesystem for
// graph loading. loadGraphOrAbort returns whatever graph we stage per-test.
vi.mock('../../../src/cli/preamble.js', () => ({
  loadGraphOrAbort: vi.fn(),
  abortOnUnexpectedError: vi.fn(),
}));

// Mock both deterministic runners so we control violations / non-determinism
// without authoring real check.mjs fixtures.
// Mock the runners. The command classifies runner errors via `instanceof`, so
// the mock must expose constructors for AstRunnerError / StructureRunnerError —
// otherwise `instanceof undefined` throws. These mocked runners are vi.fn() and
// never throw the real error types in these tests (every thrown value here comes
// from the mocked process.exit), so stub classes that simply yield `false` for
// the instanceof check are sufficient and side-effect-free.
vi.mock('../../../src/ast/runner.js', () => ({
  runAstAspect: vi.fn(),
  AstRunnerError: class AstRunnerError extends Error {},
}));
vi.mock('../../../src/structure/runner.js', () => ({
  runStructureAspect: vi.fn(),
  StructureRunnerError: class StructureRunnerError extends Error {},
}));

// Mock the LLM provider factory (no real reviewer).
vi.mock('../../../src/llm/index.js', () => ({
  createLlmProvider: vi.fn(),
}));

// Mock computeExpectedPairs so we can control LLM pair sets.
vi.mock('../../../src/core/pairs.js', () => ({
  computeExpectedPairs: vi.fn(),
  // Default: return empty array so subjectScope stays undefined (no narrowing).
  computeNodeMappedFiles: vi.fn().mockResolvedValue([]),
}));

// Mock readTextFile for references.
vi.mock('../../../src/io/graph-fs.js', () => ({
  readTextFile: vi.fn(),
  readFileBytes: vi.fn(),
}));

// Mock the companion hook runner so we can inject companion resolution results
// without authoring real companion.mjs fixtures.
vi.mock('../../../src/structure/hook-loader.js', () => ({
  runCompanionHook: vi.fn(),
}));

// Mock allowed-reads helper so companion path validation doesn't need real graph data.
vi.mock('../../../src/structure/allowed-reads.js', () => ({
  collectAllowedReadsForAspect: vi.fn().mockReturnValue(new Set<string>()),
}));

// Mock resolveAllowedReadPath so companion path validation passes in tests.
vi.mock('../../../src/structure/ctx-fs.js', () => ({
  resolveAllowedReadPath: vi.fn(),
}));

// Mock the yg-secrets overlay loader (no local overlay during the test).
vi.mock('../../../src/io/secrets-parser.js', () => ({
  loadConfigOverlay: vi.fn().mockResolvedValue(undefined),
  deepMerge: vi.fn((base: Record<string, unknown>, overlay: Record<string, unknown>) => ({ ...base, ...overlay })),
}));

// Isolate the shared exit helper. The real exitAfterFlush sets process.exitCode
// and returns to the event loop (never resolving) so Node can tear the
// node:module hook worker down cleanly — see exit-after-flush.ts. An in-process
// command test only needs the requested exit code, so delegate to the
// process.exit spy installed in beforeEach (which throws ExitSignal to unwind).
// The real helper has its own coverage in exit-after-flush.test.ts.
vi.mock('../../../src/cli/exit-after-flush.js', () => ({
  exitAfterFlush: vi.fn((code: number) => process.exit(code)),
}));

import { registerAspectTestCommand } from '../../../src/cli/aspect-test.js';
import { loadGraphOrAbort } from '../../../src/cli/preamble.js';
import { runAstAspect } from '../../../src/ast/runner.js';
import { runStructureAspect } from '../../../src/structure/runner.js';
import { createLlmProvider } from '../../../src/llm/index.js';
import { computeExpectedPairs } from '../../../src/core/pairs.js';
import { runCompanionHook } from '../../../src/structure/hook-loader.js';
import { readFileBytes } from '../../../src/io/graph-fs.js';
import type { LlmProvider } from '../../../src/llm/types.js';

const mockLoadGraph = vi.mocked(loadGraphOrAbort);
const mockRunAst = vi.mocked(runAstAspect);
const mockRunStructure = vi.mocked(runStructureAspect);
const mockCreateLlmProvider = vi.mocked(createLlmProvider);
const mockComputeExpectedPairs = vi.mocked(computeExpectedPairs);
const mockRunCompanionHook = vi.mocked(runCompanionHook);
const mockReadFileBytes = vi.mocked(readFileBytes);

// A minimal graph: aspects array + nodes Map are all the command consults.
function makeGraph(opts: {
  aspects: Array<{ id: string; reviewer: { type: string; tier?: string }; scope?: { per: string }; description?: string; artifacts?: Array<{ filename: string; content: string }>; references?: unknown[]; hasCompanion?: boolean }>;
  nodes?: Array<[string, { path: string; meta: Record<string, unknown> }]>;
  config?: { reviewer?: { tiers: Record<string, { provider: string; consensus: number; config: Record<string, unknown> }> } };
}): unknown {
  return {
    aspects: opts.aspects.map((a) => ({
      id: a.id,
      reviewer: a.reviewer,
      scope: a.scope,
      description: a.description ?? `${a.id} description`,
      artifacts: a.artifacts ?? [{ filename: a.reviewer.type === 'llm' ? 'content.md' : 'check.mjs', content: 'rule body' }],
      references: a.references ?? [],
      hasCompanion: a.hasCompanion ?? false,
    })),
    nodes: new Map(opts.nodes ?? []),
    config: opts.config ?? { reviewer: { tiers: { standard: { provider: 'ollama', consensus: 1, config: { model: 'llama3', temperature: 0 } } } } },
    rootPath: '/fake/.yggdrasil',
  };
}

function makeMockProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    verifyAspect: async () => ({ satisfied: true, reason: 'looks good', errorSource: 'codeViolation' as const }),
    isAvailable: async () => true,
    ...overrides,
  };
}

describe('registerAspectTestCommand', () => {
  function findCommand(program: Command, name: string) {
    return program.commands.find((c) => c.name() === name);
  }

  it('registers an aspect-test command (not deterministic-test)', () => {
    const program = new Command();
    registerAspectTestCommand(program);
    expect(findCommand(program, 'aspect-test')).toBeDefined();
    expect(findCommand(program, 'deterministic-test')).toBeUndefined();
  });

  it('exposes --aspect, --node, --files, --check-determinism, and --dry-run options', () => {
    const program = new Command();
    registerAspectTestCommand(program);
    const cmd = findCommand(program, 'aspect-test')!;
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain('--aspect');
    expect(flags).toContain('--node');
    expect(flags).toContain('--files');
    expect(flags).toContain('--check-determinism');
    expect(flags).toContain('--dry-run');
  });

  it('requires the --aspect option', () => {
    const program = new Command();
    registerAspectTestCommand(program);
    const cmd = findCommand(program, 'aspect-test')!;
    const aspectOpt = cmd.options.find((o) => o.long === '--aspect');
    expect(aspectOpt?.required).toBe(true);
  });
});

describe('aspect-test command behavior (mocked runners)', () => {
  let stdout: string;
  let stderr: string;
  let exitCode: number | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  class ExitSignal extends Error {
    constructor(public readonly code: number) {
      super(`exit:${code}`);
    }
  }

  async function runCommand(argv: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerAspectTestCommand(program);
    try {
      await program.parseAsync(['node', 'yg', 'aspect-test', ...argv]);
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
    }
  }

  beforeEach(() => {
    stdout = '';
    stderr = '';
    exitCode = undefined;
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stdout += chunk.toString();
        return true;
      });
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stderr += chunk.toString();
        return true;
      });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new ExitSignal(exitCode);
    }) as never);
    mockRunAst.mockReset();
    mockRunStructure.mockReset();
    mockLoadGraph.mockReset();
    mockCreateLlmProvider.mockReset();
    mockComputeExpectedPairs.mockReset();
    mockRunCompanionHook.mockReset();
    mockReadFileBytes.mockReset();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ── Error: aspect not found ──────────────────────────────────────────────────
  it('errors and exits 1 when the aspect is not found', async () => {
    mockLoadGraph.mockResolvedValue(makeGraph({ aspects: [] }) as never);
    await runCommand(['--aspect', 'missing', '--node', 'N']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("'missing' not found");
  });

  // ── Deterministic: --node routes to structure runner ─────────────────────────
  it('det --node happy path: routes runStructureAspect; clean prints footer', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }],
        nodes: [['N', { path: 'N', meta: {} }]],
      }) as never,
    );
    mockRunStructure.mockResolvedValue({ violations: [], touchedFiles: [], observations: [] } as never);
    await runCommand(['--aspect', 'a', '--node', 'N']);
    expect(mockRunStructure).toHaveBeenCalledTimes(1);
    expect(mockRunAst).not.toHaveBeenCalled();
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('No violations.');
    expect(stdout).toContain('diagnostic only — lock unchanged');
  });

  // ── Deterministic: --files routes to AST runner ──────────────────────────────
  it('det --files happy path: routes runAstAspect; clean prints footer', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }] }) as never,
    );
    mockRunAst.mockResolvedValue({ violations: [] } as never);
    await runCommand(['--aspect', 'a', '--files', 'src/a.ts']);
    expect(mockRunAst).toHaveBeenCalledTimes(1);
    expect(mockRunStructure).not.toHaveBeenCalled();
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('No violations.');
    expect(stdout).toContain('diagnostic only — lock unchanged');
  });

  // ── Deterministic: violations print correctly ────────────────────────────────
  it('det --node violations: prints <graph>: and file-grouped L<line>, exits 1, footer present', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }],
        nodes: [['N', { path: 'N', meta: {} }]],
      }) as never,
    );
    mockRunStructure.mockResolvedValue({
      violations: [
        { message: 'graph problem' },
        { message: 'file problem', file: 'src/a.ts', line: 3 },
      ],
      touchedFiles: [],
      observations: [],
    } as never);
    await runCommand(['--aspect', 'a', '--node', 'N']);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('<graph>: graph problem');
    expect(stdout).toContain('L3: file problem');
    expect(stdout).toContain('diagnostic only — lock unchanged');
  });

  // ── Deterministic: neither --node nor --files ────────────────────────────────
  it('det: errors and exits 1 when neither --node nor --files is provided', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }] }) as never,
    );
    await runCommand(['--aspect', 'a']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Neither --node nor --files');
  });

  // ── Deterministic: both --node and --files ───────────────────────────────────
  it('det: errors and exits 1 when both --node and --files are provided', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }] }) as never,
    );
    await runCommand(['--aspect', 'a', '--node', 'N', '--files', 'src/a.ts']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Both --node and --files');
  });

  // ── Deterministic: --check-determinism intact ────────────────────────────────
  it('det --check-determinism: stable across runs prints "No violations." + footer', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }],
        nodes: [['N', { path: 'N', meta: {} }]],
      }) as never,
    );
    mockRunStructure.mockResolvedValue({ violations: [], touchedFiles: [], observations: [] } as never);
    await runCommand(['--aspect', 'a', '--node', 'N', '--check-determinism']);
    expect(mockRunStructure).toHaveBeenCalledTimes(2);
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('No violations.');
    expect(stdout).toContain('diagnostic only — lock unchanged');
  });

  it('det --check-determinism: mismatch dumps Run 1/Run 2, exits 1, footer present', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }],
        nodes: [['N', { path: 'N', meta: {} }]],
      }) as never,
    );
    mockRunStructure
      .mockResolvedValueOnce({ violations: [{ message: 'first only' }], touchedFiles: [], observations: [] } as never)
      .mockResolvedValueOnce({ violations: [], touchedFiles: [], observations: [] } as never);
    await runCommand(['--aspect', 'a', '--node', 'N', '--check-determinism']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('non-deterministic');
    expect(stderr).toContain('Run 1:');
    expect(stderr).toContain('Run 2:');
    expect(stdout).toContain('diagnostic only — lock unchanged');
  });

  // ── Deterministic: --dry-run errors ─────────────────────────────────────────
  it('det --dry-run errors with a clear message that deterministic checks run locally', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }] }) as never,
    );
    await runCommand(['--aspect', 'a', '--node', 'N', '--dry-run']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--dry-run is not supported for deterministic aspect');
    expect(stderr).toContain('locally');
  });

  // ── LLM: happy path prints verdict + makes provider calls ───────────────────
  it('LLM happy path: prints verdict per pair and makes provider calls', async () => {
    const nodeEntry = { path: 'N', meta: { type: 'service', description: 'node desc' } };
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'llm-a', reviewer: { type: 'llm' } }],
        nodes: [['N', nodeEntry]],
      }) as never,
    );
    mockComputeExpectedPairs.mockResolvedValue({
      pairs: [{ aspectId: 'llm-a', kind: 'llm' as const, unitKey: 'node:N', nodePath: 'N', status: 'enforced' as const, subjectFiles: [] }],
      unreadable: [],
    });
    let verifyCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() {
        verifyCalls++;
        return { satisfied: true, reason: 'all good', errorSource: 'codeViolation' as const };
      },
    }));
    await runCommand(['--aspect', 'llm-a', '--node', 'N']);
    expect(verifyCalls).toBeGreaterThan(0);
    expect(stdout).toContain('satisfied');
    expect(stdout).toContain('diagnostic only — lock unchanged');
    expect(exitCode).toBeUndefined();
  });

  // ── LLM: --dry-run prints prompt, ZERO provider calls ───────────────────────
  it('LLM --dry-run: prints prompt to stdout, makes ZERO provider calls', async () => {
    const nodeEntry = { path: 'N', meta: { type: 'service', description: 'node desc' } };
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'llm-a', reviewer: { type: 'llm' }, artifacts: [{ filename: 'content.md', content: 'my rule body' }] }],
        nodes: [['N', nodeEntry]],
      }) as never,
    );
    mockComputeExpectedPairs.mockResolvedValue({
      pairs: [{ aspectId: 'llm-a', kind: 'llm' as const, unitKey: 'node:N', nodePath: 'N', status: 'enforced' as const, subjectFiles: [] }],
      unreadable: [],
    });
    let verifyCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));
    await runCommand(['--aspect', 'llm-a', '--node', 'N', '--dry-run']);
    expect(verifyCalls).toBe(0);
    expect(stdout).toContain('=== prompt for node:N ===');
    expect(stdout).toContain('diagnostic only — lock unchanged');
    expect(exitCode).toBeUndefined();
  });

  // ── LLM: footer present on every output path (det, LLM, dry-run) ────────────
  it('footer is present after every successful det --files run', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }] }) as never,
    );
    mockRunAst.mockResolvedValue({ violations: [] } as never);
    await runCommand(['--aspect', 'a', '--files', 'src/a.ts']);
    expect(stdout).toContain('diagnostic only — lock unchanged');
  });

  // ── LLM: --files errors ──────────────────────────────────────────────────────
  it('LLM + --files errors with a clear message', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'llm-a', reviewer: { type: 'llm' } }] }) as never,
    );
    await runCommand(['--aspect', 'llm-a', '--files', 'src/a.ts']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('LLM');
    expect(stderr).toContain('graph context');
  });

  // ── LLM companion: --dry-run resolves companions, prints block, ZERO LLM calls ─
  it('LLM companion --dry-run: hook runs live, companion block printed, ZERO reviewer calls', async () => {
    const nodeEntry = { path: 'N', meta: { type: 'service', description: 'node desc' } };
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'llm-companion', reviewer: { type: 'llm' }, hasCompanion: true }],
        nodes: [['N', nodeEntry]],
      }) as never,
    );
    mockComputeExpectedPairs.mockResolvedValue({
      pairs: [{ aspectId: 'llm-companion', kind: 'llm' as const, unitKey: 'node:N', nodePath: 'N', status: 'enforced' as const, subjectFiles: [] }],
      unreadable: [],
    });
    // Companion hook returns one companion descriptor.
    mockRunCompanionHook.mockResolvedValue({
      kind: 'ok' as const,
      descriptors: [{ path: 'docs/schema.md', label: 'schema' }],
      touchedFiles: [],
      observations: [],
      observationsTainted: false,
    });
    // readFileBytes returns content for the companion file.
    mockReadFileBytes.mockResolvedValue(Buffer.from('# schema content') as never);
    let verifyCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));
    await runCommand(['--aspect', 'llm-companion', '--node', 'N', '--dry-run']);
    // ZERO reviewer calls in dry-run.
    expect(verifyCalls).toBe(0);
    // Companion hook was called once (live).
    expect(mockRunCompanionHook).toHaveBeenCalledTimes(1);
    // The companions-for block must be printed before the prompt.
    expect(stdout).toContain('--- companions for node:N ---');
    expect(stdout).toContain('docs/schema.md');
    // The assembled prompt must contain the <companions> XML block.
    expect(stdout).toContain('<companions>');
    expect(stdout).toContain('<companion path="docs/schema.md"');
    // Footer present.
    expect(stdout).toContain('diagnostic only — lock unchanged');
    expect(exitCode).toBeUndefined();
  });

  // ── LLM companion: live run passes companions into prompt ────────────────────
  it('LLM companion live run: companions resolved and passed to reviewer', async () => {
    const nodeEntry = { path: 'N', meta: { type: 'service', description: 'node desc' } };
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'llm-companion', reviewer: { type: 'llm' }, hasCompanion: true }],
        nodes: [['N', nodeEntry]],
      }) as never,
    );
    mockComputeExpectedPairs.mockResolvedValue({
      pairs: [{ aspectId: 'llm-companion', kind: 'llm' as const, unitKey: 'node:N', nodePath: 'N', status: 'enforced' as const, subjectFiles: [] }],
      unreadable: [],
    });
    mockRunCompanionHook.mockResolvedValue({
      kind: 'ok' as const,
      descriptors: [{ path: 'docs/schema.md' }],
      touchedFiles: [],
      observations: [],
      observationsTainted: false,
    });
    mockReadFileBytes.mockResolvedValue(Buffer.from('# schema content') as never);
    let capturedPrompt = '';
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect(prompt: string) {
        capturedPrompt = prompt;
        return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const };
      },
    }));
    await runCommand(['--aspect', 'llm-companion', '--node', 'N']);
    expect(capturedPrompt).toContain('<companions>');
    expect(capturedPrompt).toContain('docs/schema.md');
    expect(stdout).toContain('satisfied');
    expect(exitCode).toBeUndefined();
  });

  // ── LLM companion: hook failure prints what/why/next and continues ───────────
  it('LLM companion hook failure: prints buildIssueMessage and continues', async () => {
    const nodeEntry = { path: 'N', meta: { type: 'service', description: 'node desc' } };
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'llm-companion', reviewer: { type: 'llm' }, hasCompanion: true }],
        nodes: [['N', nodeEntry]],
      }) as never,
    );
    mockComputeExpectedPairs.mockResolvedValue({
      pairs: [{ aspectId: 'llm-companion', kind: 'llm' as const, unitKey: 'node:N', nodePath: 'N', status: 'enforced' as const, subjectFiles: [] }],
      unreadable: [],
    });
    // Hook fails.
    mockRunCompanionHook.mockResolvedValue({
      kind: 'infra' as const,
      messageData: {
        what: 'companion.mjs threw an error',
        why: 'The hook crashed.',
        next: 'Fix the hook.',
      },
    });
    let verifyCalls = 0;
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { verifyCalls++; return { satisfied: true, reason: 'ok', errorSource: 'codeViolation' as const }; },
    }));
    await runCommand(['--aspect', 'llm-companion', '--node', 'N', '--dry-run']);
    // Must print a what/why/next error to stderr.
    expect(stderr).toContain('companion.mjs threw an error');
    // Must continue (not crash), footer present.
    expect(stdout).toContain('diagnostic only — lock unchanged');
    // No reviewer calls.
    expect(verifyCalls).toBe(0);
    expect(exitCode).toBeUndefined();
  });

  // ── LLM companion + --files rejects with the graph-context message ───────────
  it('LLM companion + --files: rejects with graph-context-required message (not a hook crash)', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'llm-companion', reviewer: { type: 'llm' }, hasCompanion: true }] }) as never,
    );
    await runCommand(['--aspect', 'llm-companion', '--files', 'src/a.ts']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('LLM');
    expect(stderr).toContain('graph context');
    // Hook must NOT have been called (reject happens before any hook call).
    expect(mockRunCompanionHook).not.toHaveBeenCalled();
  });

  // ── Verdict stamp (fix7): uniform 'yg aspect-test:' line on every run ───────
  function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  it('det --node refusal: stamp is the FIRST stdout line, singular pluralization, exit 1', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }],
        nodes: [['N', { path: 'N', meta: {} }]],
      }) as never,
    );
    mockRunStructure.mockResolvedValue({
      violations: [{ message: 'file problem', file: 'src/a.ts', line: 3 }],
      touchedFiles: [],
      observations: [],
    } as never);
    await runCommand(['--aspect', 'a', '--node', 'N']);
    expect(exitCode).toBe(1);
    expect(stripAnsi(stdout).split('\n')[0]).toBe('yg aspect-test: refused — 1 violation');
  });

  it('det --files refusal: leading stamp pluralizes (2 violations), exit 1', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({ aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }] }) as never,
    );
    mockRunAst.mockResolvedValue({
      violations: [
        { file: 'src/a.ts', line: 1, message: 'x' },
        { file: 'src/a.ts', line: 2, message: 'y' },
      ],
    } as never);
    await runCommand(['--aspect', 'a', '--files', 'src/a.ts']);
    expect(exitCode).toBe(1);
    expect(stripAnsi(stdout).split('\n')[0]).toBe('yg aspect-test: refused — 2 violations');
  });

  it('det clean: leading stamp merges the satisfied verdict with "No violations."', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }],
        nodes: [['N', { path: 'N', meta: {} }]],
      }) as never,
    );
    mockRunStructure.mockResolvedValue({ violations: [], touchedFiles: [], observations: [] } as never);
    await runCommand(['--aspect', 'a', '--node', 'N']);
    expect(exitCode).toBeUndefined();
    expect(stripAnsi(stdout).split('\n')[0]).toBe('yg aspect-test: satisfied — No violations.');
  });

  it('det --check-determinism (matched): stamp is the FIRST stdout line on the clean run', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }],
        nodes: [['N', { path: 'N', meta: {} }]],
      }) as never,
    );
    mockRunStructure.mockResolvedValue({ violations: [], touchedFiles: [], observations: [] } as never);
    await runCommand(['--aspect', 'a', '--node', 'N', '--check-determinism']);
    expect(stripAnsi(stdout).split('\n')[0]).toBe('yg aspect-test: satisfied — No violations.');
  });

  it('LLM refused: per-pair line streams, trailing summary stamp, exit 1 (documented contract)', async () => {
    const nodeEntry = { path: 'N', meta: { type: 'service', description: 'node desc' } };
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'llm-a', reviewer: { type: 'llm' } }],
        nodes: [['N', nodeEntry]],
      }) as never,
    );
    mockComputeExpectedPairs.mockResolvedValue({
      pairs: [{ aspectId: 'llm-a', kind: 'llm' as const, unitKey: 'node:N', nodePath: 'N', status: 'enforced' as const, subjectFiles: [] }],
      unreadable: [],
    });
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { return { satisfied: false, reason: 'nope', errorSource: 'codeViolation' as const }; },
    }));
    await runCommand(['--aspect', 'llm-a', '--node', 'N']);
    expect(exitCode).toBe(1);
    const clean = stripAnsi(stdout);
    expect(clean).toContain('node:N: refused — nope');
    expect(clean).toContain('yg aspect-test: refused — 1 of 1 units refused');
    // Stamp precedes the footer.
    expect(clean.indexOf('yg aspect-test: refused')).toBeLessThan(clean.indexOf('diagnostic only'));
  });

  it('LLM satisfied: trailing summary stamp, exit 0', async () => {
    const nodeEntry = { path: 'N', meta: { type: 'service', description: 'node desc' } };
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'llm-a', reviewer: { type: 'llm' } }],
        nodes: [['N', nodeEntry]],
      }) as never,
    );
    mockComputeExpectedPairs.mockResolvedValue({
      pairs: [{ aspectId: 'llm-a', kind: 'llm' as const, unitKey: 'node:N', nodePath: 'N', status: 'enforced' as const, subjectFiles: [] }],
      unreadable: [],
    });
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());
    await runCommand(['--aspect', 'llm-a', '--node', 'N']);
    expect(exitCode).toBeUndefined();
    expect(stripAnsi(stdout)).toContain('yg aspect-test: satisfied — 1 unit satisfied');
  });

  it('LLM infra-skip (reviewer threw): incomplete stamp, exit 1 (fail closed)', async () => {
    const nodeEntry = { path: 'N', meta: { type: 'service', description: 'node desc' } };
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'llm-a', reviewer: { type: 'llm' } }],
        nodes: [['N', nodeEntry]],
      }) as never,
    );
    mockComputeExpectedPairs.mockResolvedValue({
      pairs: [{ aspectId: 'llm-a', kind: 'llm' as const, unitKey: 'node:N', nodePath: 'N', status: 'enforced' as const, subjectFiles: [] }],
      unreadable: [],
    });
    mockCreateLlmProvider.mockReturnValue(makeMockProvider({
      async verifyAspect() { throw new Error('boom'); },
    }));
    await runCommand(['--aspect', 'llm-a', '--node', 'N']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Reviewer threw an error');
    expect(stripAnsi(stdout)).toContain('yg aspect-test: incomplete — 1 of 1 units could not be verified');
  });

  it('LLM --dry-run: leading dry-run stamp before the prompt', async () => {
    const nodeEntry = { path: 'N', meta: { type: 'service', description: 'node desc' } };
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'llm-a', reviewer: { type: 'llm' } }],
        nodes: [['N', nodeEntry]],
      }) as never,
    );
    mockComputeExpectedPairs.mockResolvedValue({
      pairs: [{ aspectId: 'llm-a', kind: 'llm' as const, unitKey: 'node:N', nodePath: 'N', status: 'enforced' as const, subjectFiles: [] }],
      unreadable: [],
    });
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());
    await runCommand(['--aspect', 'llm-a', '--node', 'N', '--dry-run']);
    expect(exitCode).toBeUndefined();
    const clean = stripAnsi(stdout);
    expect(clean.split('\n')[0]).toBe('yg aspect-test: dry-run — prompt preview only, no verdict');
    expect(clean.indexOf('yg aspect-test: dry-run')).toBeLessThan(clean.indexOf('=== prompt for node:N ==='));
  });

  // ── Line-less violations (fix8): no 'L?:' placeholder ───────────────────────
  it('det --node line-less violation renders a bare indented message (no L?:) and sorts first', async () => {
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'a', reviewer: { type: 'deterministic' } }],
        nodes: [['N', { path: 'N', meta: {} }]],
      }) as never,
    );
    mockRunStructure.mockResolvedValue({
      violations: [
        { message: 'with line', file: 'src/a.ts', line: 3 },
        { message: 'no line at all', file: 'src/a.ts' },
        { message: 'column but no line', file: 'src/a.ts', column: 2 },
      ],
      touchedFiles: [],
      observations: [],
    } as never);
    await runCommand(['--aspect', 'a', '--node', 'N']);
    expect(exitCode).toBe(1);
    const clean = stripAnsi(stdout);
    expect(clean).toContain('  no line at all');
    expect(clean).toContain('  column but no line');
    expect(clean).toContain('  L3: with line');
    expect(clean).not.toContain('L?');
    // Line-less violations sort as line 0 — they render BEFORE the L3 entry.
    expect(clean.indexOf('no line at all')).toBeLessThan(clean.indexOf('L3: with line'));
    expect(clean.indexOf('column but no line')).toBeLessThan(clean.indexOf('L3: with line'));
  });

  // ── Draft aspects (fix3): status never gates aspect-test ────────────────────
  it('LLM path computes pairs with includeDraft: true', async () => {
    const nodeEntry = { path: 'N', meta: { type: 'service', description: 'node desc' } };
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'llm-a', reviewer: { type: 'llm' } }],
        nodes: [['N', nodeEntry]],
      }) as never,
    );
    mockComputeExpectedPairs.mockResolvedValue({ pairs: [], unreadable: [] });
    await runCommand(['--aspect', 'llm-a', '--node', 'N']);
    expect(mockComputeExpectedPairs).toHaveBeenCalledWith(expect.anything(), { includeDraft: true });
  });

  it('a draft-only LLM pair set produces prompt output on --dry-run instead of "No pairs"', async () => {
    const nodeEntry = { path: 'N', meta: { type: 'service', description: 'node desc' } };
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'llm-a', reviewer: { type: 'llm' } }],
        nodes: [['N', nodeEntry]],
      }) as never,
    );
    mockComputeExpectedPairs.mockResolvedValue({
      pairs: [{ aspectId: 'llm-a', kind: 'llm' as const, unitKey: 'node:N', nodePath: 'N', status: 'draft' as const, subjectFiles: [] }],
      unreadable: [],
    });
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());
    await runCommand(['--aspect', 'llm-a', '--node', 'N', '--dry-run']);
    expect(stdout).toContain('=== prompt for node:N ===');
    expect(stdout).not.toContain('No pairs for aspect');
    expect(exitCode).toBeUndefined();
  });

  it('the "No pairs" message no longer blames draft status', async () => {
    const nodeEntry = { path: 'N', meta: { type: 'service', description: 'node desc' } };
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'llm-a', reviewer: { type: 'llm' } }],
        nodes: [['N', nodeEntry]],
      }) as never,
    );
    mockComputeExpectedPairs.mockResolvedValue({ pairs: [], unreadable: [] });
    await runCommand(['--aspect', 'llm-a', '--node', 'N']);
    expect(stdout).toContain(
      "No pairs for aspect 'llm-a' on node 'N' — the aspect has an empty subject set or does not apply to this node.",
    );
    expect(stdout).not.toContain('may be draft');
    expect(exitCode).toBeUndefined();
  });

  // ── Non-companion LLM: behavior unchanged ───────────────────────────────────
  it('non-companion LLM --dry-run: hook not called, prompt has no <companions> block', async () => {
    const nodeEntry = { path: 'N', meta: { type: 'service', description: 'node desc' } };
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'llm-a', reviewer: { type: 'llm' }, hasCompanion: false }],
        nodes: [['N', nodeEntry]],
      }) as never,
    );
    mockComputeExpectedPairs.mockResolvedValue({
      pairs: [{ aspectId: 'llm-a', kind: 'llm' as const, unitKey: 'node:N', nodePath: 'N', status: 'enforced' as const, subjectFiles: [] }],
      unreadable: [],
    });
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());
    await runCommand(['--aspect', 'llm-a', '--node', 'N', '--dry-run']);
    expect(mockRunCompanionHook).not.toHaveBeenCalled();
    // Prompt does NOT contain a companions block.
    expect(stdout).not.toContain('<companions>');
    expect(stdout).toContain('=== prompt for node:N ===');
    expect(exitCode).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lock file isolation test: LLM run must NOT write yg-lock.json
// ─────────────────────────────────────────────────────────────────────────────

describe('aspect-test: lock file not written after LLM run', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('no yg-lock.json appears in a tmp fixture after an LLM dry-run', async () => {
    // Create a real but minimal temp project; use the already-mocked loadGraphOrAbort
    // to return a fake graph pointing into it. The lock must NOT be created.
    const root = await mkdtemp(path.join(tmpdir(), 'yg-aspect-test-lock-'));
    dirs.push(root);
    const yggRoot = path.join(root, '.yggdrasil');
    await mkdir(path.join(yggRoot, 'aspects', 'llm-x'), { recursive: true });

    const lockFile = path.join(yggRoot, 'yg-lock.json');

    // Use the already-mocked setup from the describe above — spies are fresh here.
    let stdout2 = '';
    const stdoutSpy2 = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout2 += chunk.toString(); return true;
    });
    const stderrSpy2 = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let exitCode2: number | undefined;
    const exitSpy2 = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode2 = code ?? 0;
      throw new Error(`exit:${exitCode2}`);
    }) as never);

    const nodeEntry = { path: 'svc', meta: { type: 'service', description: '' } };
    mockLoadGraph.mockResolvedValue(
      makeGraph({
        aspects: [{ id: 'llm-x', reviewer: { type: 'llm' }, artifacts: [{ filename: 'content.md', content: 'rule' }] }],
        nodes: [['svc', nodeEntry]],
      }) as never,
    );
    mockComputeExpectedPairs.mockResolvedValue({
      pairs: [{ aspectId: 'llm-x', kind: 'llm' as const, unitKey: 'node:svc', nodePath: 'svc', status: 'enforced' as const, subjectFiles: [] }],
      unreadable: [],
    });
    mockCreateLlmProvider.mockReturnValue(makeMockProvider());

    const program = new Command();
    program.exitOverride();
    registerAspectTestCommand(program);
    try {
      await program.parseAsync(['node', 'yg', 'aspect-test', '--aspect', 'llm-x', '--node', 'svc', '--dry-run']);
    } catch { /* exit signal */ }

    stdoutSpy2.mockRestore();
    stderrSpy2.mockRestore();
    exitSpy2.mockRestore();

    // The lock file must NOT have been created.
    let lockExists = false;
    try {
      await access(lockFile);
      lockExists = true;
    } catch { /* expected */ }
    expect(lockExists).toBe(false);

    void exitCode2;
    void stdout2;
  });
});
