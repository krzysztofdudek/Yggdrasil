import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CopilotCliProvider, resolveCopilotBinary, isExtensionStub } from '../../../src/llm/copilot-cli.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function exe(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, process.platform === 'win32' ? 'copilot.cmd' : 'copilot');
  writeFileSync(f, '#!/bin/sh\necho stub\n');
  chmodSync(f, 0o755);
  return f;
}

describe('resolveCopilotBinary — the real CLI, never the VS Code extension stub', () => {
  it('skips the extension stub that sits first on PATH and takes the real CLI after it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'yg-copilot-'));
    dirs.push(root);
    const stubDir = path.join(root, 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'copilotCli');
    exe(stubDir);
    const real = exe(path.join(root, 'bin'));
    const env = { PATH: [stubDir, path.join(root, 'bin')].join(path.delimiter) };
    expect(isExtensionStub(stubDir)).toBe(true);
    expect(resolveCopilotBinary(env)).toBe(real.replace(/\\/g, '/'));
  });

  it('is null when the stub is the only copilot there is', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'yg-copilot-'));
    dirs.push(root);
    const stubDir = path.join(root, 'github.copilot-chat', 'copilotCli');
    exe(stubDir);
    expect(resolveCopilotBinary({ PATH: stubDir })).toBeNull();
  });

  it('YG_COPILOT_BIN names the binary outright', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'yg-copilot-'));
    dirs.push(root);
    const chosen = exe(path.join(root, 'elsewhere'));
    expect(resolveCopilotBinary({ PATH: '', YG_COPILOT_BIN: chosen })).toBe(chosen.replace(/\\/g, '/'));
  });
});

describe('CopilotCliProvider', () => {
  it('passes the prompt as an argument, names the configured model, and switches every outside source off', () => {
    const p = new CopilotCliProvider({ model: 'auto' });
    expect(p.stdinMode).toBe(false);
    const args = p.buildArgs('judge this');
    expect(args.slice(0, 5)).toEqual(['-p', 'judge this', '-s', '--model', 'auto']);
    for (const flag of ['--no-ask-user', '--no-custom-instructions', '--disable-builtin-mcps', '--no-auto-update']) {
      expect(args).toContain(flag);
    }
    for (const tool of ['shell', 'write', 'url', 'memory']) {
      const i = args.findIndex((a, k) => a === '--deny-tool' && args[k + 1] === tool);
      expect(i).toBeGreaterThanOrEqual(0);
    }
  });

  it('with no CLI on the machine, says so instead of spawning whatever copilot PATH has', async () => {
    const saved = { PATH: process.env.PATH, YG_COPILOT_BIN: process.env.YG_COPILOT_BIN };
    process.env.PATH = '';
    delete process.env.YG_COPILOT_BIN;
    try {
      const r = await new CopilotCliProvider({ model: 'auto' }).verifyAspect('x');
      expect(r.satisfied).toBe(false);
      expect(r.errorSource).toBe('provider');
      expect(r.reason).toContain('GitHub Copilot CLI not found');
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.YG_COPILOT_BIN !== undefined) process.env.YG_COPILOT_BIN = saved.YG_COPILOT_BIN;
    }
  });
});
