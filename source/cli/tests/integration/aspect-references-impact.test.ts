import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(__dirname, '..', '..', 'dist', 'bin.js');

describe('integration — yg impact --file with references', () => {
  const repos: string[] = [];
  afterEach(() => { while (repos.length > 0) rmSync(repos.pop()!, { recursive: true, force: true }); });

  it('returns nodes whose aspects reference the file', () => {
    const repo = mkdtempSync(join(tmpdir(), 'yg-impact-refs-'));
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    mkdirSync(join(ygg, 'aspects', 'a'), { recursive: true });
    mkdirSync(join(ygg, 'model', 'svc'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'src', 'svc.ts'), 'x', 'utf-8');
    writeFileSync(join(repo, 'docs', 'codes.md'), 'CODE_1', 'utf-8');
    writeFileSync(join(ygg, 'yg-config.yaml'), `version: "5.1.0"
reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config: { model: m, endpoint: http://x }
`, 'utf-8');
    writeFileSync(join(ygg, 'yg-architecture.yaml'), `node_types:
  module:
    description: m
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'a', 'yg-aspect.yaml'), `name: A
description: t
reviewer: { type: llm }
references:
  - docs/codes.md
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'yg-node.yaml'), `name: svc
type: module
mapping:
  - src/svc.ts
aspects:
  - a
`, 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'log.md'), '# log\n', 'utf-8');

    // docs/codes.md is referenced by aspect A on node svc, but not mapped to any node.
    // After fix, impact --file should show svc as a cascade-via-reference node.
    let stdout: string, stderr = '';
    try {
      stdout = execFileSync('node', [CLI, 'impact', '--file', 'docs/codes.md'], {
        cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: any) { stdout = e.stdout ?? ''; stderr = e.stderr ?? ''; }

    // Either exit 0 with svc listed in stdout/stderr, or print svc in the summary.
    const all = stdout + stderr;
    expect(all).toContain('svc');
  });

  it('shows both structural owner and cascade-via-reference nodes when file is mapped and referenced', () => {
    const repo = mkdtempSync(join(tmpdir(), 'yg-impact-dual-'));
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    mkdirSync(join(ygg, 'aspects', 'a'), { recursive: true });
    mkdirSync(join(ygg, 'model', 'svc'), { recursive: true });
    mkdirSync(join(ygg, 'model', 'consumer'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'shared'), { recursive: true });
    writeFileSync(join(repo, 'src', 'svc.ts'), 'x', 'utf-8');
    writeFileSync(join(repo, 'shared', 'codes.ts'), 'export const C = 1;', 'utf-8');
    writeFileSync(join(ygg, 'yg-config.yaml'), `version: "5.1.0"
reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config: { model: m, endpoint: http://x }
`, 'utf-8');
    writeFileSync(join(ygg, 'yg-architecture.yaml'), `node_types:
  module:
    description: m
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'a', 'yg-aspect.yaml'), `name: A
description: t
reviewer: { type: llm }
references:
  - shared/codes.ts
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');
    // svc owns shared/codes.ts via mapping
    writeFileSync(join(ygg, 'model', 'svc', 'yg-node.yaml'), `name: svc
type: module
mapping:
  - shared/codes.ts
`, 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'log.md'), '# log\n', 'utf-8');
    // consumer has aspect A which references shared/codes.ts (but doesn't own it)
    writeFileSync(join(ygg, 'model', 'consumer', 'yg-node.yaml'), `name: consumer
type: module
mapping:
  - src/svc.ts
aspects: [a]
`, 'utf-8');
    writeFileSync(join(ygg, 'model', 'consumer', 'log.md'), '# log\n', 'utf-8');

    // shared/codes.ts is owned by svc AND referenced by aspect A on consumer
    let stdout: string, stderr = '';
    try {
      stdout = execFileSync('node', [CLI, 'impact', '--file', 'shared/codes.ts'], {
        cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: any) { stdout = e.stdout ?? ''; stderr = e.stderr ?? ''; }

    const all = stdout + stderr;
    // Structural owner: svc
    expect(all).toContain('svc');
    // Cascade via reference: consumer appears in the unified invalidation block
    expect(all).toContain('consumer');
    expect(all).toContain('references this file');
    expect(all).toContain('Total to re-verify:');
  });
});
