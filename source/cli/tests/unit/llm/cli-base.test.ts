import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseAspectResponse } from '../../../src/llm/cli-base.js';
import { initDebugLog, _resetForTesting } from '../../../src/utils/debug-log.js';
import { writeFileSync, chmodSync } from 'node:fs';
import { CliAgentProvider } from '../../../src/llm/cli-base.js';
import { probeProvider } from '../../../src/llm/provider.js';

describe('parseAspectResponse', () => {
  it('parses clean JSON', () => {
    const result = parseAspectResponse('{"satisfied": true, "reason": "ok"}');
    expect(result).toEqual({ satisfied: true, reason: 'ok', errorSource: 'codeViolation' });
  });

  it('parses JSON in markdown fence', () => {
    const result = parseAspectResponse('```json\n{"satisfied": false, "reason": "fail"}\n```');
    expect(result).toEqual({ satisfied: false, reason: 'fail', errorSource: 'codeViolation' });
  });

  it('extracts embedded JSON from text', () => {
    const result = parseAspectResponse('Here is my analysis: {"satisfied": true, "reason": "pass"} done.');
    expect(result).toEqual({ satisfied: true, reason: 'pass', errorSource: 'codeViolation' });
  });

  it('extracts the verdict when prose BEFORE it contains brace characters', () => {
    // A verbose reviewer emits markdown analysis (with code snippets and the
    // literal `{ what, why, next }`) and then the JSON verdict. A greedy
    // outermost-brace match would span the prose braces and fail; the verdict
    // scanner must still recover the trailing `{"satisfied": ...}` object.
    const prose = [
      'Looking at the source against each rule:',
      '',
      '**Output routing** — all results use `process.stdout.write()`.',
      'Messages follow `{ what, why, next }` via buildIssueMessage.',
      '',
      '{"satisfied": true, "reason": "all rules met"}',
    ].join('\n');
    const result = parseAspectResponse(prose);
    expect(result).toEqual({ satisfied: true, reason: 'all rules met', errorSource: 'codeViolation' });
  });

  it('picks the LAST satisfied-bearing object when several braces appear', () => {
    const prose = 'Consider {"foo": 1} and a snippet { a: b }, final verdict: {"satisfied": false, "reason": "rule 3 violated"}';
    const result = parseAspectResponse(prose);
    expect(result).toEqual({ satisfied: false, reason: 'rule 3 violated', errorSource: 'codeViolation' });
  });

  it('brace-laden prose WITHOUT a satisfied verdict still fails closed (provider error)', () => {
    // Braces everywhere, but no JSON object with a boolean `satisfied` — must not
    // be coerced into a code PASS; it is an infrastructure (provider) error.
    const prose = 'The function returns `{ ok: true }` and logs `{ level: "info" }` but I could not finish.';
    const result = parseAspectResponse(prose);
    expect(result?.satisfied).toBe(false);
    expect(result?.errorSource).toBe('provider');
  });

  it('returns undefined for empty string', () => {
    expect(parseAspectResponse('')).toBeUndefined();
  });

  // A3b: an unparseable (non-JSON) response is NOT heuristically guessed as a code
  // verdict — a junk reply containing "satisfied" must not become a code-PASS. It is
  // classified as a provider (infrastructure) error so the fail-closed gate refuses.
  it('unparseable response that mentions "satisfied" is a provider error, not a code PASS', () => {
    const result = parseAspectResponse('The code is satisfied with all requirements.');
    expect(result?.satisfied).toBe(false);
    expect(result?.errorSource).toBe('provider');
  });

  it('unparseable response that mentions "not satisfied" is a provider error', () => {
    const result = parseAspectResponse('The code is not satisfied with requirement X.');
    expect(result?.satisfied).toBe(false);
    expect(result?.errorSource).toBe('provider');
  });

  it('unparseable ambiguous text is a provider error', () => {
    const result = parseAspectResponse('I cannot determine if the code is satisfied.');
    expect(result?.satisfied).toBe(false);
    expect(result?.errorSource).toBe('provider');
  });
});

// Raw-response debug logging — when debug:true and a reviewer reply cannot be
// parsed into a verdict, the raw reply is written to .debug.log so the failure can
// be diagnosed (it is otherwise invisible). The success path stays silent (only on
// parse failure, per the agreed contract). These are private, opt-in local logs.
describe('parseAspectResponse — raw-output debug logging', () => {
  let tmpDir: string;

  function appendFn(filePath: string, text: string): void {
    appendFileSync(filePath, text, 'utf-8');
  }
  function logContent(): string {
    return readFileSync(path.join(tmpDir, '.debug.log'), 'utf-8');
  }

  afterEach(() => {
    _resetForTesting();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes the raw reply to the debug log when the reply cannot be parsed', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yg-parse-fail-'));
    initDebugLog(tmpDir, true, appendFn);
    const garbage = 'GARBAGE-NO-VERDICT thinking blah blah no json here at all';
    const result = parseAspectResponse(garbage);
    expect(result?.errorSource).toBe('provider');
    expect(logContent()).toContain(garbage);
  });

  it('notes an empty reply in the debug log', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yg-parse-empty-'));
    initDebugLog(tmpDir, true, appendFn);
    expect(parseAspectResponse('   ')).toBeUndefined();
    expect(logContent()).toContain('empty');
  });

  it('does NOT write the raw reply when the reply parses successfully', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'yg-parse-ok-'));
    initDebugLog(tmpDir, true, appendFn);
    const result = parseAspectResponse('{"satisfied": true, "reason": "UNIQUE-SUCCESS-MARKER"}');
    expect(result?.satisfied).toBe(true);
    expect(logContent()).not.toContain('UNIQUE-SUCCESS-MARKER');
  });
});

// ── Failure reasons: a failed CLI run names its cause ──────────────────────────
// A bad login, an unknown model and a timeout used to read identically
// ("Reviewer unavailable"), with the CLI's own stderr thrown away even in the
// debug log. The reason now carries how it failed and what the CLI printed.

class FakeCliProvider extends CliAgentProvider {
  constructor(private readonly bin: string, timeout?: number) { super({ model: 'm', timeout }); }
  get binary() { return this.bin; }
  get stdinMode() { return true; }
  buildArgs(): string[] { return []; }
  protected get installHint() { return 'install the fake CLI'; }
}

describe('CliAgentProvider — failure reasons', () => {
  const made: string[] = [];
  afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function script(body: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yg-fake-cli-'));
    made.push(dir);
    const f = path.join(dir, 'fake-cli');
    writeFileSync(f, `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  }

  it.skipIf(process.platform === 'win32')('a non-zero exit reports the exit code and the redacted stderr tail', async () => {
    const bin = script('cat >/dev/null\necho "Invalid API key · Please run /login (sk-ant-api03-abcdefghijklmnop)" >&2\nexit 3');
    const r = await new FakeCliProvider(bin).verifyAspect('prompt');
    expect(r.errorSource).toBe('provider');
    expect(r.reason).toContain('exited with code 3');
    expect(r.reason).toContain('Invalid API key · Please run /login');
    expect(r.reason).toContain('sk-ant-[REDACTED]');
    expect(r.reason).not.toContain('abcdefghijklmnop');
  });

  it.skipIf(process.platform === 'win32')('a timeout says so and names config.timeout', async () => {
    const bin = script('cat >/dev/null\necho "still thinking" >&2\nexec sleep 20');
    const r = await new FakeCliProvider(bin, 500).verifyAspect('prompt');
    expect(r.errorSource).toBe('provider');
    expect(r.reason).toContain('timed out after 1s');
    expect(r.reason).toContain('config.timeout');
    expect(r.reason).toContain('still thinking');
  });

  it.skipIf(process.platform === 'win32')('a clean exit with no verdict says so instead of "unavailable"', async () => {
    const bin = script('cat >/dev/null\necho "model not found: m" >&2\nexit 0');
    const r = await new FakeCliProvider(bin).verifyAspect('prompt');
    expect(r.reason).toContain('exited 0 without a verdict');
    expect(r.reason).toContain('model not found: m');
  });

  it('a missing binary is unavailable with "not found on PATH" and the install hint', async () => {
    const p = new FakeCliProvider('yg-no-such-cli-zzz');
    const probe = await probeProvider(p, 'fake');
    expect(probe).toEqual({ available: false, reason: "'yg-no-such-cli-zzz' was not found on PATH — install the fake CLI" });
  });

  it('the full stderr goes to the debug log on a non-zero exit', async () => {
    if (process.platform === 'win32') return;
    const bin = script('cat >/dev/null\necho "line one of the diagnosis" >&2\nexit 1');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yg-debuglog-'));
    made.push(dir);
    initDebugLog(dir, true, (f, t) => appendFileSync(f, t));
    try {
      await new FakeCliProvider(bin).verifyAspect('prompt');
    } finally {
      _resetForTesting();
    }
    expect(readFileSync(path.join(dir, '.debug.log'), 'utf-8')).toContain('stderr: line one of the diagnosis');
  });
});
