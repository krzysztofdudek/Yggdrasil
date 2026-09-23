// The reviewer subprocess boundary: whatever the reviewer CLI does to its end of
// the pipes, a call settles as a provider (infrastructure) outcome within its
// time limit — never an unhandled stream error that kills the whole run, and
// never a hang because something the reviewer started still holds the pipes.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CliAgentProvider, needsShellToSpawn } from '../../../src/llm/cli-base.js';
import { GeminiCliProvider } from '../../../src/llm/gemini-cli.js';

class FakeReviewer extends CliAgentProvider {
  private readonly bin: string;
  private readonly shell: boolean;
  constructor(bin: string, opts: { timeout?: number; shell?: boolean; model?: string } = {}) {
    super({ model: opts.model ?? 'test-model', timeout: opts.timeout });
    this.bin = bin;
    this.shell = opts.shell ?? false;
  }
  get binary() { return this.bin; }
  get stdinMode() { return true; }
  buildArgs(): string[] { return []; }
  protected get spawnShell(): boolean { return this.shell; }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function script(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yg-fake-reviewer-'));
  dirs.push(dir);
  const file = path.join(dir, 'reviewer');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe.skipIf(process.platform === 'win32')('CLI reviewer subprocess', () => {
  it('a reviewer that exits without reading its prompt is a provider failure, not a crash (EPIPE on stdin)', async () => {
    const reviewer = new FakeReviewer(script('exit 3'));
    const prompt = 'x'.repeat(4 * 1024 * 1024); // far past any pipe buffer
    const res = await reviewer.verifyAspect(prompt);
    expect(res.satisfied).toBe(false);
    expect(res.errorSource).toBe('provider');
  });

  it('the timeout ends the whole process group, so a helper still holding the pipes cannot hang the call', async () => {
    // The helper outlives the test's own limit by far: the call settles only if
    // the timeout reaches the helper too (killing just the reviewer leaves the
    // helper holding stdout, and 'close' would not come for ten minutes).
    const reviewer = new FakeReviewer(script('(sleep 600) &\nsleep 600'), { timeout: 300 });
    const res = await reviewer.verifyAspect('prompt');
    expect(res.errorSource).toBe('provider');
  }, 20_000);

  it('a spawn that throws synchronously resolves as a provider failure', async () => {
    const res = await new FakeReviewer('bad\0name').verifyAspect('prompt');
    expect(res).toMatchObject({ satisfied: false, errorSource: 'provider' });
  });

  it('a model name that could reach a shell is refused before anything is spawned', async () => {
    const res = await new FakeReviewer(script('exit 0'), { shell: true, model: 'x & rm -rf ~' }).verifyAspect('prompt');
    expect(res).toMatchObject({ satisfied: false, errorSource: 'provider' });
    expect(res.reason).toContain('is not a model name');
  });
});

describe('Windows shims', () => {
  it('a .cmd/.bat shim, or a bare name on Windows, is started through a shell', () => {
    expect(needsShellToSpawn('C:/npm/claude.cmd', 'linux')).toBe(true);
    expect(needsShellToSpawn('C:/npm/codex.BAT', 'win32')).toBe(true);
    expect(needsShellToSpawn('gemini', 'win32')).toBe(true);
  });

  it('an .exe or a POSIX binary is spawned directly', () => {
    expect(needsShellToSpawn('C:/bin/claude.exe', 'win32')).toBe(false);
    expect(needsShellToSpawn('claude', 'linux')).toBe(false);
    expect(needsShellToSpawn('/usr/local/bin/codex', 'darwin')).toBe(false);
  });
});

describe('gemini-cli sends the prompt on stdin', () => {
  it('never puts the prompt in argv (a large prompt exceeds one argument / the Windows command line)', () => {
    const p = new GeminiCliProvider({ model: 'gemini-2.5-pro' });
    expect(p.stdinMode).toBe(true);
    const args = p.buildArgs('the whole prompt');
    expect(args).not.toContain('the whole prompt');
    expect(args).toEqual(expect.arrayContaining(['-m', 'gemini-2.5-pro', '-o', 'json']));
  });
});
