import { describe, it, expect, afterEach, vi } from 'vitest';
import { listKnowledge, readKnowledge } from '../../../src/cli/knowledge.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

function captureOutput(fn: () => void): { stdout: string; stderr: string; exitCode: number | null } {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let exitCode: number | null = null;
  vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
    stdoutChunks.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
    stderrChunks.push(String(s));
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);
  try {
    fn();
  } catch (e) {
    if (e instanceof ExitSignal) {
      exitCode = e.code;
    } else {
      throw e;
    }
  }
  return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), exitCode };
}

describe('listKnowledge', () => {
  it('shows available topics header', () => {
    const { stdout } = captureOutput(() => listKnowledge());
    expect(stdout).toMatch(/Available knowledge topics:/);
  });

  it('shows all 13 topic names', () => {
    const { stdout } = captureOutput(() => listKnowledge());
    expect(stdout).toContain('working-with-architecture');
    expect(stdout).toContain('aspects-overview');
    expect(stdout).toContain('aspect-status');
    expect(stdout).toContain('cli-reference');
    expect(stdout).toContain('conditional-aspects');
    expect(stdout).toContain('configuration');
    expect(stdout).toContain('verification-and-lock');
    expect(stdout).toContain('suppress-syntax');
    expect(stdout).toContain('writing-deterministic-aspects');
    expect(stdout).toContain('writing-llm-aspects');
    expect(stdout).toContain('log-management');
    expect(stdout).toContain('ports-and-relations');
    expect(stdout).toContain('flows');
  });

  it('shows summaries alongside topic names', () => {
    const { stdout } = captureOutput(() => listKnowledge());
    expect(stdout).toMatch(/working-with-architecture\s+\S/);
  });

  it('shows read instruction at the end', () => {
    const { stdout } = captureOutput(() => listKnowledge());
    expect(stdout).toMatch(/yg knowledge read/);
  });
});

describe('readKnowledge', () => {
  it('prints content of a known topic', () => {
    const { stdout } = captureOutput(() => readKnowledge('working-with-architecture'));
    expect(stdout).toMatch(/Working with the architecture file/);
  });

  it('prints content of cli-reference topic', () => {
    const { stdout } = captureOutput(() => readKnowledge('cli-reference'));
    expect(stdout).toMatch(/yg check/);
  });

  it('exits 1 and writes to stderr for unknown topic', () => {
    const { stderr, exitCode } = captureOutput(() => readKnowledge('nonexistent-topic'));
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Unknown knowledge topic 'nonexistent-topic'/);
    expect(stderr).toContain('Available:');
    expect(stderr).toMatch(/yg knowledge list/);
  });

  it('lists available topics in stderr for unknown topic', () => {
    const { stderr } = captureOutput(() => readKnowledge('nonexistent-topic'));
    expect(stderr).toContain('working-with-architecture');
  });

  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'])(
    'treats inherited Object.prototype key %s as an unknown topic (no crash)',
    (name) => {
      const { stderr, exitCode } = captureOutput(() => readKnowledge(name));
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(new RegExp(`Unknown knowledge topic`));
      expect(stderr).toContain('Available:');
    },
  );
});
