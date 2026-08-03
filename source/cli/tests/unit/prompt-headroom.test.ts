import { describe, it, expect, vi, afterEach } from 'vitest';
// resolveTierLimits is the pure config-reading half of the prompt-headroom
// measurement script: given the RAW TEXT of a committed yg-config.yaml, it
// returns the real max_prompt_chars ceiling for every declared reviewer tier,
// or throws when it cannot establish one. No subprocess, no built dist —
// exercised directly, mirroring this suite's own spectral-headroom.test.ts
// precedent for a plain-ESM script at the repo root.
// @ts-expect-error — plain ESM script at the repo root, no type declarations.
import { resolveTierLimits, ENGINE_DEFAULT_MAX_PROMPT_CHARS, buildOverrideSecretsText, installInterruptRestore } from '../../../../scripts/prompt-headroom.mjs';

describe('prompt-headroom — resolveTierLimits reads the real committed ceiling', () => {
  it('is not fooled by a larger number sitting in a comment above the live value', () => {
    // This is this repo's OWN standard tier block shape: years of raise
    // history recorded as prose comments, with a bigger number than the
    // live setting sitting right above it. A regex that takes the FIRST
    // `max_prompt_chars:` match in the block, without stripping comments,
    // reads the commented-out 200000 as if it were live.
    const configText = [
      'version: "5.2.0"',
      'reviewer:',
      '  default: standard',
      '  tiers:',
      '    standard:',
      '      provider: claude-code',
      '      # Raised from 50000 to 64000, then 68000, then 72000.',
      '      # Considered max_prompt_chars: 200000 but larger prompts get lossy.',
      '      max_prompt_chars: 72000',
      '',
    ].join('\n');
    const tierLimits = resolveTierLimits(configText, 'yg-config.yaml');
    expect(tierLimits.get('standard')).toBe(72000);
    expect(tierLimits.get('standard')).not.toBe(200000);
  });

  it('finds tiers: regardless of what key precedes it under reviewer: (no fixed-offset text scan)', () => {
    // A sibling key ahead of `tiers:` under `reviewer:` used to break a regex
    // anchored on `reviewer:\s*\n\s*tiers:\s*\n` — real YAML parsing has no
    // such positional assumption.
    const configText = [
      'version: "5.2.0"',
      'reviewer:',
      '  default: standard',
      '  tiers:',
      '    standard:',
      '      max_prompt_chars: 90000',
      '',
    ].join('\n');
    const tierLimits = resolveTierLimits(configText, 'yg-config.yaml');
    expect(tierLimits.get('standard')).toBe(90000);
  });

  it('reads every declared tier, each its own ceiling', () => {
    const configText = [
      'reviewer:',
      '  tiers:',
      '    standard:',
      '      max_prompt_chars: 72000',
      '    big:',
      '      max_prompt_chars: 120000',
      '',
    ].join('\n');
    const tierLimits = resolveTierLimits(configText, 'yg-config.yaml');
    expect(tierLimits.get('standard')).toBe(72000);
    expect(tierLimits.get('big')).toBe(120000);
    expect(tierLimits.size).toBe(2);
  });

  it('a tier that omits max_prompt_chars gets the engine\'s own default, never silently 0 or missing', () => {
    const configText = ['reviewer:', '  tiers:', '    standard:', '      provider: claude-code', ''].join('\n');
    const tierLimits = resolveTierLimits(configText, 'yg-config.yaml');
    expect(tierLimits.get('standard')).toBe(ENGINE_DEFAULT_MAX_PROMPT_CHARS);
  });

  it('throws rather than silently measuring nothing when the file is not valid YAML at all', () => {
    const configText = 'reviewer:\n  tiers:\n    standard:\n  : this is not : valid : yaml : at all\n';
    expect(() => resolveTierLimits(configText, 'yg-config.yaml')).toThrow(/did not parse as YAML/);
  });

  it('throws when reviewer.tiers is missing entirely, rather than reporting "nothing to measure"', () => {
    const configText = 'version: "5.2.0"\ncoverage:\n  required: [src/]\n';
    expect(() => resolveTierLimits(configText, 'yg-config.yaml')).toThrow(/reviewer\.tiers/);
  });

  it('throws when reviewer.tiers is present but empty', () => {
    const configText = 'reviewer:\n  tiers: {}\n';
    expect(() => resolveTierLimits(configText, 'yg-config.yaml')).toThrow(/reviewer\.tiers/);
  });

  it('throws on a non-positive-integer max_prompt_chars rather than reporting a bogus ceiling', () => {
    const configText = 'reviewer:\n  tiers:\n    standard:\n      max_prompt_chars: -5\n';
    expect(() => resolveTierLimits(configText, 'yg-config.yaml')).toThrow(/not a positive integer/);
  });
});

describe('prompt-headroom — buildOverrideSecretsText never wipes the maintainer\'s own overlay', () => {
  it('with no existing overlay, writes only the measurement override', () => {
    const text = buildOverrideSecretsText(null, ['standard']);
    expect(text).toContain('max_prompt_chars: 1');
    expect(text).toMatch(/standard/);
  });

  it("merges the override INTO a real maintainer overlay instead of replacing it — the provider, endpoint, and model all survive", () => {
    // The exact shape a maintainer's local reviewer override takes (a real
    // provider pointed at a local model) — this is what a wholesale
    // `writeFileSync(SECRETS_PATH, template)` used to throw away entirely.
    const maintainerOverlay = [
      '# MY REAL LOCAL OVERLAY',
      'parallel: 1',
      'reviewer:',
      '  tiers:',
      '    standard:',
      '      provider: ollama',
      '      config:',
      '        model: a-local-model',
      '        endpoint: http://localhost:11434',
      '',
    ].join('\n');
    const merged = buildOverrideSecretsText(maintainerOverlay, ['standard']);
    expect(merged).toContain('ollama');
    expect(merged).toContain('a-local-model');
    expect(merged).toContain('http://localhost:11434');
    expect(merged).toMatch(/parallel:\s*1/);
    expect(merged).toMatch(/max_prompt_chars:\s*1\b/);
  });

  it('overrides every declared tier, not only the first', () => {
    const merged = buildOverrideSecretsText(null, ['standard', 'big']);
    expect(merged).toMatch(/standard:[\s\S]*max_prompt_chars: 1/);
    expect(merged).toMatch(/big:[\s\S]*max_prompt_chars: 1/);
  });
});

describe('prompt-headroom — installInterruptRestore restores on every catchable interruption signal, not only on a normal exit', () => {
  afterEach(() => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGHUP');
    process.removeAllListeners('SIGQUIT');
    vi.restoreAllMocks();
  });

  it('SIGINT calls restore() and exits 130 — Ctrl-C mid-run must not skip the restore', () => {
    const restore = vi.fn();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installInterruptRestore(restore);
    process.emit('SIGINT');
    expect(restore).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it('SIGTERM calls restore() and exits 143 — a CI job kill mid-run must not skip the restore', () => {
    const restore = vi.fn();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installInterruptRestore(restore);
    process.emit('SIGTERM');
    expect(restore).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(143);
  });

  it('SIGHUP calls restore() and exits 129 — a closed terminal or a dropped SSH session must not skip the restore', () => {
    // SIGHUP is exactly as catchable as SIGINT/SIGTERM, and just as terminal by
    // default: a session drop mid-run used to skip the restore the same way an
    // unhandled SIGINT or SIGTERM would, leaving the 1-char override behind.
    const restore = vi.fn();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installInterruptRestore(restore);
    process.emit('SIGHUP');
    expect(restore).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(129);
  });

  it('SIGQUIT calls restore() and exits 131 — Ctrl-\\ mid-run must not skip the restore', () => {
    const restore = vi.fn();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installInterruptRestore(restore);
    process.emit('SIGQUIT');
    expect(restore).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(131);
  });
});
