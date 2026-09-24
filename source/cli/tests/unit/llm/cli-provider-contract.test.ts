// The codex and gemini-cli reviewers, held to what the real CLIs accept.
//
// The argv below is pinned to the versions it was verified against by reading
// each CLI's own --help and running it headless against a local stub API:
// codex-cli 0.156.1 (`codex exec --help`) and @google/gemini-cli 0.61.0
// (`gemini --help`). A change to either list is a change to that contract and
// must be re-verified against a real binary, not just re-pinned here.
//
// The fake binaries emulate the behaviours of those versions that decided
// whether a verdict came back at all: codex reads --output-schema as a FILE
// path, refuses to run outside a git repository without --skip-git-repo-check,
// and prints JSONL events (not the reply) under --json; gemini refuses an
// untrusted working directory in headless mode without --skip-trust, wraps the
// reply in a JSON envelope under `-o json`, and crashes on an empty MCP
// allow-list entry.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexProvider } from '../../../src/llm/codex.js';
import { GeminiCliProvider } from '../../../src/llm/gemini-cli.js';

const WORK = '/tmp/yg-reviewer-XXXX';

describe('codex argv contract (codex-cli 0.156.1)', () => {
  it('runs exec non-interactively, outside git, read-only, with no tools, MCP, rules or web search, in its private directory', () => {
    const args = new CodexProvider({ model: 'gpt-5' }).buildArgs('', WORK);
    expect(args).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--color', 'never',
      '--disable', 'shell_tool',
      '--disable', 'view_image',
      '--disable', 'multi_agent',
      '--disable', 'goals',
      '-c', 'web_search=disabled',
      '-C', WORK,
      '-m', 'gpt-5',
      '--output-schema', path.join(WORK, 'verdict-schema.json'),
      '-',
    ]);
  });

  it('never asks for JSONL events: the reply itself must be what lands on stdout', () => {
    expect(new CodexProvider({ model: 'gpt-5' }).buildArgs('', WORK)).not.toContain('--json');
  });
});

describe('gemini-cli argv contract (@google/gemini-cli 0.61.0)', () => {
  it('prints the reply as text, trusts only its private directory, and runs with no tools, extensions or MCP servers', () => {
    const args = new GeminiCliProvider({ model: 'gemini-2.5-flash' }).buildArgs('', WORK);
    expect(args).toEqual([
      '-o', 'text',
      '-m', 'gemini-2.5-flash',
      '--skip-trust',
      '--approval-mode', 'plan',
      '-e', 'none',
      '--allowed-mcp-server-names', 'yg-reviewer-allows-no-mcp-server',
      '--policy', path.join(WORK, 'deny-all-tools.toml'),
    ]);
  });

  it('never puts the prompt on the command line', () => {
    const args = new GeminiCliProvider({ model: 'm' }).buildArgs('SECRET SOURCE', WORK);
    expect(args.join(' ')).not.toContain('SECRET SOURCE');
  });
});

// ── End to end through the real spawn path, against fakes of those versions ──

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1]; };
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, cwd: process.cwd(), cwdFiles: fs.readdirSync(process.cwd()) }));
const schema = val('--output-schema');
if (schema !== undefined) {
  try { JSON.parse(fs.readFileSync(schema, 'utf8')); } catch (e) {
    process.stderr.write('Failed to read output schema file ' + schema + ': No such file or directory (os error 2)\\n'); process.exit(1);
  }
}
const root = val('-C') ?? process.cwd();
let inGit = false; for (let d = root; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, '.git'))) { inGit = true; break; } if (path.dirname(d) === d) break; }
if (!inGit && !argv.includes('--skip-git-repo-check')) { process.stderr.write('Not inside a trusted directory and --skip-git-repo-check was not specified.\\n'); process.exit(1); }
let input = ''; process.stdin.on('data', (d) => { input += d; }); process.stdin.on('end', () => {
  const reply = JSON.stringify({ satisfied: false, reason: 'fake refusal: TODO found' });
  process.stderr.write('codex\\n' + reply + '\\ntokens used\\n15\\n');
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ type: 'thread.started' }) + '\\n' + JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reply } }) + '\\n');
  } else process.stdout.write(reply + '\\n');
});
`;

const FAKE_GEMINI = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1]; };
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, cwd: process.cwd(), cwdFiles: fs.readdirSync(process.cwd()) }));
if (val('--allowed-mcp-server-names') === '') { process.stderr.write('Error: Invalid policy rule: mcpName is required if specified (cannot be empty).\\n'); process.exit(1); }
if (!argv.includes('--skip-trust')) { process.stderr.write('Gemini CLI is not running in a trusted directory. To proceed, either use \`--skip-trust\`...\\n'); process.exit(55); }
let input = ''; process.stdin.on('data', (d) => { input += d; }); process.stdin.on('end', () => {
  const reply = JSON.stringify({ satisfied: true, reason: 'fake approval' });
  if (val('-o') === 'json') process.stdout.write(JSON.stringify({ session_id: 'x', response: reply, stats: {} }, null, 2));
  else process.stdout.write(reply + '\\n');
});
`;

describe.skipIf(process.platform === 'win32')('codex and gemini-cli reviewers return a verdict from the real spawn path', () => {
  let binDir: string;
  let logFile: string;
  const savedPath = process.env.PATH;
  const savedLog = process.env.FAKE_LOG;

  beforeEach(() => {
    binDir = mkdtempSync(path.join(tmpdir(), 'yg-fake-cli-'));
    logFile = path.join(binDir, 'argv.json');
    writeFileSync(path.join(binDir, 'codex'), FAKE_CODEX);
    writeFileSync(path.join(binDir, 'gemini'), FAKE_GEMINI);
    chmodSync(path.join(binDir, 'codex'), 0o755);
    chmodSync(path.join(binDir, 'gemini'), 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
    process.env.FAKE_LOG = logFile;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedLog === undefined) delete process.env.FAKE_LOG; else process.env.FAKE_LOG = savedLog;
    rmSync(binDir, { recursive: true, force: true });
  });

  it('codex: the verdict is read, from a private working directory holding only the schema, which is removed afterwards', async () => {
    const res = await new CodexProvider({ model: 'gpt-5', timeout: 30_000 }).verifyAspect('review this');
    expect(res).toEqual({ satisfied: false, reason: 'fake refusal: TODO found', errorSource: 'codeViolation' });
    const seen = JSON.parse(readFileSync(logFile, 'utf8')) as { argv: string[]; cwd: string; cwdFiles: string[] };
    expect(path.basename(seen.cwd)).toMatch(/^yg-reviewer-/);
    expect(seen.cwdFiles).toEqual(['verdict-schema.json']);
    expect(seen.argv[seen.argv.indexOf('-C') + 1]).toBe(seen.cwd);
    expect(existsSync(seen.cwd)).toBe(false);
  });

  it('gemini-cli: the verdict is read, from a private working directory holding only the deny-all policy, which is removed afterwards', async () => {
    const res = await new GeminiCliProvider({ model: 'gemini-2.5-flash', timeout: 30_000 }).verifyAspect('review this');
    expect(res).toEqual({ satisfied: true, reason: 'fake approval', errorSource: 'codeViolation' });
    const seen = JSON.parse(readFileSync(logFile, 'utf8')) as { argv: string[]; cwd: string; cwdFiles: string[] };
    expect(path.basename(seen.cwd)).toMatch(/^yg-reviewer-/);
    expect(seen.cwdFiles).toEqual(['deny-all-tools.toml']);
    expect(existsSync(seen.cwd)).toBe(false);
  });

  it('no private working directory is left behind when the reviewer fails', async () => {
    writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\nexit 7\n');
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('yg-reviewer-')).length;
    const res = await new CodexProvider({ model: 'gpt-5', timeout: 30_000 }).verifyAspect('review this');
    expect(res.errorSource).toBe('provider');
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('yg-reviewer-')).length).toBeLessThanOrEqual(before);
  });
});
