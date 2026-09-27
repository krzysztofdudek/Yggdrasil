// Reviewer credentials in the committed configuration, a tracked secrets
// overlay, and a committed endpoint that would receive the environment's key.
// All three are warnings: where a reviewer key sits and where it goes is the
// repository owner's call, so none of them blocks and no key is withheld.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConfig } from '../../../src/io/config-parser.js';
import { checkReviewerCredentials } from '../../../src/core/checks/credentials.js';
import { STRUCTURAL_CODES } from '../../../src/utils/check-codes.js';
import type { Graph } from '../../../src/model/graph.js';

const dirs: string[] = [];
const savedKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => { delete process.env.ANTHROPIC_API_KEY; });
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
});

/** A git repository holding .yggdrasil/yg-config.yaml (and optionally the overlay), committed. */
function project(config: string, secrets?: string, opts: { trackSecrets?: boolean } = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'yg-cred-'));
  dirs.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  mkdirSync(path.join(root, '.yggdrasil'));
  writeFileSync(path.join(root, '.yggdrasil', '.gitignore'), 'yg-secrets.yaml\n');
  writeFileSync(path.join(root, '.yggdrasil', 'yg-config.yaml'), config);
  if (secrets !== undefined) writeFileSync(path.join(root, '.yggdrasil', 'yg-secrets.yaml'), secrets);
  git('add', '-A');
  if (opts.trackSecrets) git('add', '-f', '.yggdrasil/yg-secrets.yaml');
  git('commit', '-qm', 'init');
  return root;
}

async function issuesFor(root: string) {
  const config = await parseConfig(path.join(root, '.yggdrasil', 'yg-config.yaml'));
  const graph = { config, rootPath: path.join(root, '.yggdrasil') } as unknown as Graph;
  return checkReviewerCredentials(graph);
}

const tier = (extra: string) => `version: "6.0.0"
reviewer:
  tiers:
    standard:
      provider: anthropic
      consensus: 1
      config:
        model: claude-x
${extra}`;

describe('checkReviewerCredentials', () => {
  it('an api_key in the committed yg-config.yaml is a warning, never a block, and never repeats the key', async () => {
    const root = project(tier('        api_key: sk-ant-committed-123\n'));
    const issues = await issuesFor(root);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'warning', code: 'config-committed-api-key' });
    expect(JSON.stringify(issues)).not.toContain('sk-ant-committed-123');
    expect(STRUCTURAL_CODES.has('config-committed-api-key')).toBe(false);
    // The key stays in effect: the tier carries it to the provider.
    const config = await parseConfig(path.join(root, '.yggdrasil', 'yg-config.yaml'));
    expect(config.reviewer?.tiers.standard.api_key).toBe('sk-ant-committed-123');
  });

  it('an api_key in the gitignored overlay is the documented place and passes', async () => {
    const issues = await issuesFor(project(tier(''), 'reviewer:\n  tiers:\n    standard:\n      config:\n        api_key: sk-local\n'));
    expect(issues).toEqual([]);
  });

  it('a force-tracked yg-secrets.yaml is a warning, and the key it holds stays in effect', async () => {
    const root = project(tier(''), 'reviewer:\n  tiers:\n    standard:\n      config:\n        api_key: sk-tracked\n', { trackSecrets: true });
    const issues = await issuesFor(root);
    expect(issues.map((i) => [i.severity, i.code])).toEqual([['warning', 'secrets-file-tracked']]);
    expect(STRUCTURAL_CODES.has('secrets-file-tracked')).toBe(false);
    expect(JSON.stringify(issues)).not.toContain('sk-tracked');
    const config = await parseConfig(path.join(root, '.yggdrasil', 'yg-config.yaml'));
    expect(config.reviewer?.tiers.standard.api_key).toBe('sk-tracked');
  });

  it('a committed plain-http endpoint that would receive the environment key is warned about, whether or not the key is set here', async () => {
    const root = project(tier('        endpoint: http://127.0.0.1:9911\n'));
    // The finding is about the committed file: it reads the same on every machine.
    expect((await issuesFor(root)).map((i) => i.code)).toEqual(['reviewer-endpoint-committed']);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    const issues = await issuesFor(root);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'warning', code: 'reviewer-endpoint-committed' });
    expect(issues[0].messageData?.what).toContain('http://127.0.0.1:9911');
    expect(issues[0].messageData?.what).toContain('plain http');
    expect(JSON.stringify(issues)).not.toContain('sk-ant-env');
  });

  it('the canonical endpoint, or an endpoint set in the local overlay, is not flagged', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    expect(await issuesFor(project(tier('        endpoint: https://api.anthropic.com/v1/\n')))).toEqual([]);
    expect(await issuesFor(project(tier(''), 'reviewer:\n  tiers:\n    standard:\n      config:\n        endpoint: http://127.0.0.1:9911\n'))).toEqual([]);
  });

  it('a key stored in the local overlay does not exempt a committed endpoint: the key goes there, and the warning says so', async () => {
    const root = project(tier('        endpoint: https://proxy.example.test/v1\n'), 'reviewer:\n  tiers:\n    standard:\n      config:\n        api_key: sk-local\n');
    const issues = await issuesFor(root);
    expect(issues.map((i) => [i.severity, i.code])).toEqual([['warning', 'reviewer-endpoint-committed']]);
    expect(issues[0].messageData?.what).toContain('sends its API key');
    expect(JSON.stringify(issues)).not.toContain('sk-local');
  });

  it('a stored key and an openai-compatible endpoint named only in the committed file are warned about', async () => {
    const compat = `version: "6.0.0"\nreviewer:\n  tiers:\n    standard:\n      provider: openai-compatible\n      consensus: 1\n      config:\n        model: m\n        endpoint: https://gw.example.test/v1\n`;
    const issues = await issuesFor(project(compat, 'reviewer:\n  tiers:\n    standard:\n      config:\n        api_key: sk-stored\n'));
    expect(issues.map((i) => [i.severity, i.code])).toEqual([['warning', 'reviewer-endpoint-committed']]);
    expect(JSON.stringify(issues)).not.toContain('sk-stored');
  });
});
