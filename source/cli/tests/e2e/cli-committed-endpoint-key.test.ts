// =============================================================================
// CLI E2E — a reviewer key is never withheld; yg check only warns.
//
// yg-config.yaml is shared: whoever last changed it decides a tier's
// config.endpoint, and may even hold the key itself. Where the key sits and
// where it goes is the repository owner's call, so Yggdrasil sends it wherever
// the tier points and never turns the check red over it: a committed endpoint
// that is not the provider's own, a stored key reaching a committed
// openai-compatible server, a yg-secrets.yaml tracked by git, and a key written
// straight into yg-config.yaml each give a warning and nothing more. This
// drives the real binary and looks at what arrives: capture servers speaking
// the Anthropic and OpenAI wire formats record every request's key header.
//
// HERMETIC: mkdtemp project, capture server on an ephemeral loopback port, the
// child's environment stripped of every provider key but the one under test.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJson, expectIssue, expectNoIssue, type OutputDoc } from '../support/assert-output.js';
import { runGitFixture } from '../support/git-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(__dirname, '..', '..', 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

const LOCAL_KEY = 'sk-ant-DEVELOPER-LOCAL-KEY';

function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/** An anthropic tier whose committed yg-config.yaml points config.endpoint at `endpoint`. */
function project(endpoint: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'yg-committed-endpoint-'));
  w(root, '.yggdrasil/yg-config.yaml', `version: "6.0.0"
quality:
  max_direct_relations: 10
reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 1
      max_prompt_chars: 50000
      config:
        model: claude-x
        temperature: 0
        endpoint: "${endpoint}"
`);
  w(root, '.yggdrasil/yg-architecture.yaml', `node_types:
  app:
    description: 'The application code.'
    log_required: false
    when:
      path: "src/**"
    aspects:
      - reviewed
`);
  w(root, '.yggdrasil/model/app/yg-node.yaml', `name: App
description: The application code.
type: app
mapping:
  - src/
`);
  w(root, '.yggdrasil/aspects/reviewed/yg-aspect.yaml', `name: Reviewed
description: A reviewer rule, so a fill calls the reviewer.
reviewer:
  type: llm
status: enforced
`);
  w(root, '.yggdrasil/aspects/reviewed/content.md', '# Anything passes\n\nThe file must exist.\n');
  w(root, 'src/app.ts', 'export const app = 1;\n');
  return root;
}

interface Capture {
  endpoint: string;
  keys: Array<string | undefined>;
  close(): Promise<void>;
}

/** An Anthropic-format server that approves everything and records each request's x-api-key. */
async function captureServer(): Promise<Capture> {
  const keys: Array<string | undefined> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on('data', () => {});
    req.on('end', () => {
      const key = req.headers['x-api-key'];
      keys.push(Array.isArray(key) ? key.join(',') : key);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: [{ text: JSON.stringify({ satisfied: true, reason: 'ok' }) }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `http://127.0.0.1:${port}/v1`,
    keys,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function run(args: string[], cwd: string): Promise<{ status: number | null; stdout: string; all: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['CI', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_COMPATIBLE_API_KEY']) delete env[k];
  env.ANTHROPIC_API_KEY = LOCAL_KEY;
  return new Promise((resolve) => {
    const child = spawn('node', [BIN_PATH, ...args], { cwd, env });
    let stdout = '';
    let all = '';
    child.stdout.on('data', (d) => { stdout += String(d); all += String(d); });
    child.stderr.on('data', (d) => { all += String(d); });
    child.on('close', (status) => resolve({ status, stdout, all }));
  });
}

describe.skipIf(!distExists)('a committed first-party endpoint and the developer\'s key', () => {
  it('the committed endpoint receives the key, check only warns, and the output never shows the key', async () => {
    const server = await captureServer();
    const root = project(server.endpoint);
    try {
      const read = await run(['check', '--json'], root);
      expectIssue(parseJson<OutputDoc>(read.stdout), { code: 'reviewer-endpoint-committed', severity: 'warning' });

      const fill = await run(['check', '--approve', '--json'], root);
      expect(fill.status, fill.all).toBe(0);
      expect(server.keys.length).toBeGreaterThan(0);
      expect(server.keys.every((k) => k === LOCAL_KEY), JSON.stringify(server.keys)).toBe(true);
      expect(fill.all).not.toContain(LOCAL_KEY);
      const doc = parseJson<OutputDoc>(fill.stdout);
      expectIssue(doc, { code: 'reviewer-endpoint-committed', severity: 'warning' });
      expectNoIssue(doc, { code: 'unverified' });
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('naming the same endpoint in yg-secrets.yaml makes it a local choice: the key goes there, and the warning is gone', async () => {
    const server = await captureServer();
    const root = project(server.endpoint);
    w(root, '.yggdrasil/yg-secrets.yaml', `reviewer:
  tiers:
    standard:
      config:
        endpoint: "${server.endpoint}"
`);
    try {
      const fill = await run(['check', '--approve', '--json'], root);
      expect(fill.status, fill.all).toBe(0);
      expect(server.keys.length).toBeGreaterThan(0);
      expect(server.keys.every((k) => k === LOCAL_KEY), JSON.stringify(server.keys)).toBe(true);
      expectNoIssue(parseJson<OutputDoc>(fill.stdout), { code: 'reviewer-endpoint-committed' });
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const STORED = 'sk-STORED-FOR-AN-EARLIER-REVIEWER';

/** An OpenAI-format server that approves everything and records each request's Authorization header. */
async function openAiCapture(): Promise<{ endpoint: string; auth: Array<string | undefined>; close(): Promise<void> }> {
  const auth: Array<string | undefined> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on('data', () => {});
    req.on('end', () => {
      auth.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ satisfied: true, reason: 'ok' }) } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { endpoint: `http://127.0.0.1:${port}/v1`, auth, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** The same project, its committed tier switched to openai-compatible at `endpoint`. */
function compatProject(endpoint: string): string {
  const root = project(endpoint);
  const cfg = path.join(root, '.yggdrasil', 'yg-config.yaml');
  writeFileSync(cfg, readFileSync(cfg, 'utf-8').replace('provider: anthropic', 'provider: openai-compatible'), 'utf-8');
  return root;
}

// A key stored in yg-secrets.yaml for one reviewer follows a committed switch
// of the provider to an openai-compatible server: allowed, and warned about.
describe.skipIf(!distExists)('a key stored in yg-secrets.yaml and a committed openai-compatible endpoint', () => {
  it('the committed server receives the stored key; check warns until the endpoint is named locally', async () => {
    const server = await openAiCapture();
    const root = compatProject(server.endpoint);
    try {
      w(root, '.yggdrasil/yg-secrets.yaml', `reviewer:\n  tiers:\n    standard:\n      config:\n        api_key: ${STORED}\n`);
      const fill = await run(['check', '--approve', '--json'], root);
      expect(fill.status, fill.all).toBe(0);
      expect(server.auth.length).toBeGreaterThan(0);
      expect(server.auth.every((a) => a === `Bearer ${STORED}`), JSON.stringify(server.auth)).toBe(true);
      expect(fill.all).not.toContain(STORED);
      expectIssue(parseJson<OutputDoc>(fill.stdout), { code: 'reviewer-endpoint-committed', severity: 'warning' });

      w(root, '.yggdrasil/yg-secrets.yaml', `reviewer:\n  tiers:\n    standard:\n      config:\n        api_key: ${STORED}\n        endpoint: "${server.endpoint}"\n`);
      const local = await run(['check', '--json'], root);
      expect(local.status, local.all).toBe(0);
      expectNoIssue(parseJson<OutputDoc>(local.stdout), { code: 'reviewer-endpoint-committed' });
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// A yg-secrets.yaml tracked by git is shared like the committed file. That is
// the owner's call: its key still goes out, and check warns.
describe.skipIf(!distExists)('a tracked yg-secrets.yaml', () => {
  it('its key is sent and secrets-file-tracked is a warning that leaves the check green', async () => {
    const server = await captureServer();
    const root = project(server.endpoint);
    try {
      w(root, '.yggdrasil/yg-secrets.yaml', `reviewer:\n  tiers:\n    standard:\n      config:\n        api_key: ${STORED}\n`);
      runGitFixture(root, ['init', '-q', '-b', 'main']);
      runGitFixture(root, ['add', '-A']);
      runGitFixture(root, ['add', '-f', '.yggdrasil/yg-secrets.yaml']);
      runGitFixture(root, ['commit', '-qm', 'project with a tracked overlay']);
      const fill = await run(['check', '--approve', '--json'], root);
      expect(fill.status, fill.all).toBe(0);
      expect(server.keys.length).toBeGreaterThan(0);
      expect(server.keys.every((k) => k === STORED), JSON.stringify(server.keys)).toBe(true);
      expect(fill.all).not.toContain(STORED);
      const doc = parseJson<OutputDoc>(fill.stdout);
      expectIssue(doc, { code: 'secrets-file-tracked', severity: 'warning' });
      expectNoIssue(doc, { code: 'unverified' });
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// A key written straight into the committed yg-config.yaml works: the owner
// decided to share it. check warns (config-committed-api-key) and stays green.
describe.skipIf(!distExists)('a key written in yg-config.yaml', () => {
  it('is sent, and config-committed-api-key is a warning that leaves the check green', async () => {
    const committedKey = 'sk-ant-COMMITTED-IN-CONFIG';
    const server = await captureServer();
    const root = project(server.endpoint);
    try {
      const cfg = path.join(root, '.yggdrasil', 'yg-config.yaml');
      writeFileSync(cfg, readFileSync(cfg, 'utf-8').replace('        temperature: 0\n', `        temperature: 0\n        api_key: ${committedKey}\n`), 'utf-8');
      runGitFixture(root, ['init', '-q', '-b', 'main']);
      runGitFixture(root, ['add', '-A']);
      runGitFixture(root, ['commit', '-qm', 'project with a committed key']);
      const fill = await run(['check', '--approve', '--json'], root);
      expect(fill.status, fill.all).toBe(0);
      expect(server.keys.length).toBeGreaterThan(0);
      // config.api_key outranks ANTHROPIC_API_KEY, committed or not.
      expect(server.keys.every((k) => k === committedKey), JSON.stringify(server.keys)).toBe(true);
      expect(fill.all).not.toContain(committedKey);
      const doc = parseJson<OutputDoc>(fill.stdout);
      expectIssue(doc, { code: 'config-committed-api-key', severity: 'warning' });
      expectNoIssue(doc, { code: 'unverified' });

      const read = await run(['check'], root);
      expect(read.status, read.all).toBe(0);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
