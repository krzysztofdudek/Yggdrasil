// Reviewer credentials in the committed configuration, a tracked secrets
// overlay, and a committed endpoint that would receive the environment's key.
// Before: all three passed `yg check` silently.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConfig } from '../../../src/io/config-parser.js';
import { checkReviewerCredentials } from '../../../src/core/checks/credentials.js';
import { STRUCTURAL_CODES } from '../../../src/core/check-codes.js';
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
  it('an api_key in the committed yg-config.yaml is a blocking error that never repeats the key', async () => {
    const issues = await issuesFor(project(tier('        api_key: sk-ant-committed-123\n')));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'error', code: 'config-committed-api-key' });
    expect(JSON.stringify(issues)).not.toContain('sk-ant-committed-123');
    expect(STRUCTURAL_CODES.has('config-committed-api-key')).toBe(true);
  });

  it('an api_key in the gitignored overlay is the documented place and passes', async () => {
    const issues = await issuesFor(project(tier(''), 'reviewer:\n  tiers:\n    standard:\n      config:\n        api_key: sk-local\n'));
    expect(issues).toEqual([]);
  });

  it('a force-tracked yg-secrets.yaml is a blocking error', async () => {
    const issues = await issuesFor(project(tier(''), 'reviewer:\n  tiers:\n    standard:\n      config:\n        model: claude-x\n', { trackSecrets: true }));
    expect(issues.map((i) => [i.severity, i.code])).toEqual([['error', 'secrets-file-tracked']]);
    expect(STRUCTURAL_CODES.has('secrets-file-tracked')).toBe(true);
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
});
