import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readRulesArtifacts } from '../../../src/cli/rules-artifacts.js';
import { installRules } from '../../../src/templates/platform.js';
import { checkDigestGate } from '../../../src/core/checks/digest-gate.js';
import { initDebugLog, _resetForTesting } from '../../../src/utils/debug-log.js';

/**
 * readRulesArtifacts — the fs-touching CLI boundary that feeds the
 * committed-digest staleness gate.
 *
 * Load-bearing property: the reader must see exactly what `yg init` WROTE. The
 * installer reuses an existing case variant (`Agents.md`, `Claude.md`) and
 * writes an `@Agents.md` import line to match. On a case-sensitive filesystem
 * (Linux / CI), a reader hardcoding `AGENTS.md` sees nothing in such a repo and
 * the gate reports a correctly-installed repo's digest block as MISSING — a
 * warning `yg init --upgrade` can never clear, since the installer keeps
 * writing to the variant the reader ignores.
 *
 * These run against a real temp repo driven by the real installer, so the
 * reader and writer are checked against each other rather than a fixture.
 */

const V = '9.9.9';
let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'yg-artifacts-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const write = (p: string, c: string) => { writeFileSync(path.join(root, p), c, 'utf-8'); };

describe('readRulesArtifacts', () => {
  it('reads the canonically-named artifacts a fresh install writes', async () => {
    await installRules(root, V);
    const a = await readRulesArtifacts(root);
    expect(a.agentsMd).toBe(readFileSync(path.join(root, 'AGENTS.md'), 'utf-8'));
    expect(a.claudeMd).toBe('@AGENTS.md\n');
    expect(a.clinerules).not.toBeNull();
    expect(checkDigestGate(a)).toHaveLength(0);
  });

  it('a repo whose files are Agents.md / Claude.md reads as INSTALLED, not missing', async () => {
    // The repo already carries lowercase-ish variants; the installer reuses
    // them (and writes an `@Agents.md` import to match) rather than creating a
    // second, differently-cased file.
    write('Agents.md', '# My project\n');
    write('Claude.md', '# Claude\n');
    await installRules(root, V);

    // Preconditions: the installer really did use the variants.
    expect(readFileSync(path.join(root, 'Agents.md'), 'utf-8')).toContain('yggdrasil:start');
    expect(readFileSync(path.join(root, 'Claude.md'), 'utf-8')).toContain('@Agents.md');

    const a = await readRulesArtifacts(root);
    expect(a.agentsMd).toContain('yggdrasil:start');
    expect(a.claudeMd).toContain('@Agents.md');

    // The whole point: a correctly-installed case-variant repo is SILENT.
    expect(checkDigestGate(a)).toHaveLength(0);
  });

  it('absent artifacts read as null rather than throwing', async () => {
    const a = await readRulesArtifacts(root);
    expect(a.agentsMd).toBeNull();
    expect(a.claudeMd).toBeNull();
    expect(a.clinerules).toBeNull();
    expect(a.canonicalDigestHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * The diagnostic contract, pinned in both directions.
 *
 * A plain missing file is the ORDINARY state of an optional artifact (a project with no
 * `.clinerules/` directory, or one where the install was never run) and the gate already
 * reports it as a missing artifact — a debug line there would fire on the most common
 * path and say nothing new. Every OTHER failure collapses to the same `null` in the
 * returned value, so an unreadable-but-present file would otherwise be indistinguishable
 * from one that was never installed; that case IS recorded.
 *
 * The unreadable case is produced with a real directory standing where the file belongs
 * (a read of it fails, and never with ENOENT) rather than by revoking permissions, which
 * a root-owned CI container would not honor.
 */
describe('rules-artifact read diagnostics', () => {
  /** Captured debug-log writes. The tee is torn down before any assertion runs. */
  let captured: string[];
  const startCapture = (): void => {
    captured = [];
    initDebugLog(root, true, (_p, text) => { captured.push(text); });
  };
  const stopCapture = (): string => { _resetForTesting(); return captured.join(''); };
  afterEach(() => { _resetForTesting(); });

  it('a file that is simply absent records NO diagnostic', async () => {
    startCapture();
    const a = await readRulesArtifacts(root);
    const log = stopCapture();
    expect(a.clinerules).toBeNull();
    expect(a.agentsMd).toBeNull();
    expect(log).not.toContain('[check] readRules');
  });

  it('a read that fails for any OTHER reason records the file and the error', async () => {
    // A directory where the file belongs: the read fails, and not with ENOENT.
    mkdirSync(path.join(root, '.clinerules', 'yggdrasil.md'), { recursive: true });
    startCapture();
    const a = await readRulesArtifacts(root);
    const log = stopCapture();
    expect(a.clinerules).toBeNull();
    expect(log).toContain('[check] readRules');
    expect(log).toContain('yggdrasil.md');
  });
});
