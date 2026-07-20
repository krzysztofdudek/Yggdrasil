import { describe, it, expect, afterEach, vi } from 'vitest';
import { listSchemas, readSchema } from '../../../src/cli/schemas.js';

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

describe('listSchemas', () => {
  it('shows available schemas header', () => {
    const { stdout } = captureOutput(() => listSchemas());
    expect(stdout).toMatch(/Available schemas:/);
  });

  it('shows all 5 schema names', () => {
    const { stdout } = captureOutput(() => listSchemas());
    expect(stdout).toContain('node');
    expect(stdout).toContain('aspect');
    expect(stdout).toContain('architecture');
    expect(stdout).toContain('config');
    expect(stdout).toContain('flow');
  });

  it('shows summaries alongside schema names', () => {
    const { stdout } = captureOutput(() => listSchemas());
    expect(stdout).toMatch(/node\s+\S/);
  });

  it('shows read instruction at the end', () => {
    const { stdout } = captureOutput(() => listSchemas());
    expect(stdout).toMatch(/yg schemas read/);
  });
});

describe('readSchema', () => {
  it('prints content of a known schema', () => {
    const { stdout } = captureOutput(() => readSchema('node'));
    expect(stdout).toMatch(/# yg-node\.yaml/);
  });

  it('prints content of the aspect schema', () => {
    const { stdout } = captureOutput(() => readSchema('aspect'));
    expect(stdout).toMatch(/# yg-aspect\.yaml/);
  });

  it('exits 1 and writes to stderr for unknown schema', () => {
    const { stderr, exitCode } = captureOutput(() => readSchema('nonexistent-schema'));
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Unknown schema 'nonexistent-schema'/);
    expect(stderr).toContain('Available:');
    expect(stderr).toMatch(/yg schemas list/);
  });

  it('lists available schemas in stderr for unknown schema', () => {
    const { stderr } = captureOutput(() => readSchema('nonexistent-schema'));
    expect(stderr).toContain('node');
  });

  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'])(
    'treats inherited Object.prototype key %s as an unknown schema (no crash)',
    (name) => {
      const { stderr, exitCode } = captureOutput(() => readSchema(name));
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(new RegExp(`Unknown schema`));
      expect(stderr).toContain('Available:');
    },
  );
});
