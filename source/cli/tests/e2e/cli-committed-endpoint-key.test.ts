// =============================================================================
// CLI E2E — a committed endpoint never receives a developer's key unasked.
//
// yg-config.yaml is shared: whoever last changed it decides a tier's
// config.endpoint. The key a first-party provider (anthropic, openai, google)
// sends is the developer's own — the environment variable, or yg-secrets.yaml.
// Before this, a committed endpoint other than the provider's own received that
// key on the next `yg check --approve`, and check only printed a warning. Now
// the key goes there only when the developer names the endpoint locally in
// yg-secrets.yaml. This drives the real binary and looks at what arrives: a
// capture server speaking the Anthropic wire format records every request's
// x-api-key header.
//
// HERMETIC: mkdtemp project, capture server on an ephemeral loopback port, the
// child's environment stripped of every provider key but the one under test.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJson, expectIssue, expectNoIssue, type OutputDoc } from '../support/assert-output.js';

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
  it('the committed endpoint receives nothing: the key is withheld, check warns, and the output never shows the key', async () => {
    const server = await captureServer();
    const root = project(server.endpoint);
    try {
      const read = await run(['check', '--json'], root);
      expectIssue(parseJson<OutputDoc>(read.stdout), { code: 'reviewer-endpoint-committed', severity: 'warning' });

      const fill = await run(['check', '--approve', '--json'], root);
      expect(server.keys, fill.all).toEqual([]);
      expect(fill.all).not.toContain(LOCAL_KEY);
      expect(fill.status, fill.all).not.toBe(0);
      // The tier's pair is left unjudged for want of a reviewer, not judged by the committed endpoint.
      expectIssue(parseJson<OutputDoc>(fill.stdout), { code: 'unverified', cause: 'reviewer-unreachable' });
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('naming the same endpoint in yg-secrets.yaml is the local opt-in: the key goes there, and the warning is gone', async () => {
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
