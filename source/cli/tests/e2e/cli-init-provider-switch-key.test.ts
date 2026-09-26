// =============================================================================
// CLI E2E — a provider switch never sends the previous provider's key.
//
// yg-secrets.yaml's `config.api_key` outranks the provider's environment
// variable. A key stored there for one reviewer, left behind when
// `yg init --provider` points the tier somewhere else, would be sent to the new
// endpoint while init said no key would be used. This drives the real binary
// end to end and looks at what actually arrives: an OpenAI-compatible capture
// server records the Authorization header of every request the reviewer makes.
//
// HERMETIC: mkdtemp project, capture server on an ephemeral loopback port,
// the child's environment stripped of every provider key.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(__dirname, '..', '..', 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

const STALE = 'sk-ant-STALE-FROM-PREVIOUS-PROVIDER';

function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/** A project configured for anthropic, with that provider's key stored in the overlay. */
function anthropicProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'yg-switch-key-'));
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
`);
  w(root, '.yggdrasil/yg-secrets.yaml', `reviewer:
  tiers:
    standard:
      config:
        api_key: ${STALE}
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
  auth: Array<string | undefined>;
  close(): Promise<void>;
}

/** An OpenAI-compatible server that approves everything and records each request's Authorization header. */
async function captureServer(): Promise<Capture> {
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
  return {
    endpoint: `http://127.0.0.1:${port}/v1`,
    auth,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function run(args: string[], cwd: string): Promise<{ status: number | null; all: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['CI', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_COMPATIBLE_API_KEY']) delete env[k];
  return new Promise((resolve) => {
    const child = spawn('node', [BIN_PATH, ...args], { cwd, env });
    let all = '';
    child.stdout.on('data', (d) => { all += String(d); });
    child.stderr.on('data', (d) => { all += String(d); });
    child.on('close', (status) => resolve({ status, all }));
  });
}

describe.skipIf(!distExists)('yg init --provider — the previous provider\'s key stays behind', () => {
  it('after switching anthropic → openai-compatible, the new endpoint receives no key at all, and init said so', async () => {
    const root = anthropicProject();
    const server = await captureServer();
    try {
      const init = await run(['init', '--provider', 'openai-compatible', '--model', 'local', '--endpoint', server.endpoint], root);
      expect(init.status, init.all).toBe(0);
      expect(init.all).toContain('Removed the api_key .yggdrasil/yg-secrets.yaml held for this tier (stored while the tier used anthropic)');
      expect(init.all).toContain(`No API key found in $OPENAI_COMPATIBLE_API_KEY; the reviewer will call ${server.endpoint} without one.`);
      expect(init.all).not.toContain(STALE);

      const fill = await run(['check', '--approve'], root);
      expect(fill.status, fill.all).toBe(0);
      // The reviewer really called the new endpoint — and sent it no credential.
      expect(server.auth.length).toBeGreaterThan(0);
      expect(server.auth.every((a) => a === undefined), JSON.stringify(server.auth)).toBe(true);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
