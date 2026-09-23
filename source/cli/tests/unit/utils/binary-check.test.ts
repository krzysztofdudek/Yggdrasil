import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { binaryAvailable } from '../../../src/utils/binary-check.js';
import { probeBinary } from '../../../src/utils/binary-check.js';

describe('binaryAvailable', () => {
  it('returns true for a binary that runs with --version', async () => {
    // `node` is guaranteed present in the test environment and supports
    // `--version` on every platform — exercises the clean-exit (available) path.
    expect(await binaryAvailable('node')).toBe(true);
  });

  it('returns false for a binary that is not installed', async () => {
    // A name that cannot resolve on PATH — exercises the catch (unavailable)
    // path. Crucially this is the case the old `which`-based probe got wrong on
    // Windows (where `which` itself is absent); the new probe reports it the
    // same way on every platform.
    expect(await binaryAvailable('yg-definitely-not-a-real-binary-zzz')).toBe(false);
  });
});

describe('probeBinary — keeps the cause', () => {
  it('says "not found on PATH" for a binary that is not installed', async () => {
    expect(await probeBinary('yg-definitely-not-a-real-binary-zzz')).toEqual({ ok: false, detail: "'yg-definitely-not-a-real-binary-zzz' was not found on PATH" });
  });

  it('is ok for a binary that runs', async () => {
    expect(await probeBinary('node')).toEqual({ ok: true });
  });
});

// Every other cause probeBinary can name, driven by a real script on disk rather
// than a mocked execFile: the failure has to come out of an actual spawn for the
// test to say anything about the message a reader will see. POSIX only — the
// scripts are shell scripts, and on Windows the probe goes through a shell that
// reports these differently (the "not recognized" line is covered below as text).
describe.skipIf(process.platform === 'win32')('probeBinary — each cause in words a reader can act on', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function script(body: string, mode = 0o755): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'yg-binprobe-'));
    dirs.push(dir);
    const file = path.join(dir, 'fake-cli');
    writeFileSync(file, `#!/bin/sh\n${body}\n`, 'utf-8');
    chmodSync(file, mode);
    return file;
  }

  it.skipIf(process.getuid?.() === 0)('says "not executable" for a file without the execute bit', async () => {
    // root ignores the execute bit for its own spawn permission check, so the
    // refusal only exists for an ordinary user.
    const file = script('exit 0', 0o644);
    expect(await probeBinary(file)).toEqual({ ok: false, detail: `'${file}' is not executable` });
  });

  it('names the exit code and the last thing the binary printed', async () => {
    const file = script('echo "first line" >&2\necho "config file is broken" >&2\nexit 3');
    expect(await probeBinary(file)).toEqual({
      ok: false,
      detail: `'${file} --version' exited with code 3: first line config file is broken`,
    });
  });

  it('names only the exit code when the binary printed nothing', async () => {
    const file = script('exit 2');
    expect(await probeBinary(file)).toEqual({ ok: false, detail: `'${file} --version' exited with code 2` });
  });

  it('reads a shell\'s "command not found" as not found on PATH, not as a broken install', async () => {
    const file = script('echo "fake-cli: command not found" >&2\nexit 127');
    expect(await probeBinary(file)).toEqual({ ok: false, detail: `'${file}' was not found on PATH` });
  });

  it('reads a Windows shell\'s "not recognized" line the same way', async () => {
    const file = script("echo \"'claude' is not recognized as an internal or external command,\" >&2\nexit 1");
    expect(await probeBinary(file)).toEqual({ ok: false, detail: `'${file}' was not found on PATH` });
  });

  it('reports a binary killed by a signal as one that did not finish, not as an exit code', async () => {
    const file = script('kill -TERM $$');
    expect(await probeBinary(file)).toEqual({ ok: false, detail: `'${file} --version' did not finish within 10s` });
  });

  it('masks a credential the binary printed before it failed', async () => {
    const file = script('echo "auth failed for sk-ant-abcdefghijklmnop" >&2\nexit 1');
    const probe = await probeBinary(file);
    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      expect(probe.detail).toContain('sk-ant-[REDACTED]');
      expect(probe.detail).not.toContain('abcdefghijklmnop');
    }
  });
});
