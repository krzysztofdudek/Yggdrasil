import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(__dirname, '..', '..', 'dist', 'bin.js');

const YG_CONFIG = `
version: "5.2.0"
reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config: { model: m, endpoint: http://x }
`;

const YG_ARCH = `
node_types:
  service:
    description: Service
    log_required: false
    when:
      path: "src/**"
`;

describe('integration — yg context surfaces aspect references', () => {
  const repos: string[] = [];
  afterEach(() => {
    while (repos.length > 0) rmSync(repos.pop()!, { recursive: true, force: true });
  });

  it('yg context --file lists both content.md and reference paths with description', () => {
    const repo = mkdtempSync(join(tmpdir(), 'yg-refs-ctx-'));
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    mkdirSync(join(ygg, 'aspects', 'a'), { recursive: true });
    mkdirSync(join(ygg, 'model', 'svc'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'docs'), { recursive: true });

    writeFileSync(join(repo, 'src', 'svc.ts'), 'export const x = 1;\n', 'utf-8');
    writeFileSync(join(repo, 'docs', 'codes.md'), 'CODE_1\n', 'utf-8');
    writeFileSync(join(ygg, 'yg-config.yaml'), YG_CONFIG, 'utf-8');
    writeFileSync(join(ygg, 'yg-architecture.yaml'), YG_ARCH, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'a', 'yg-aspect.yaml'), `name: A
description: t
reviewer: { type: llm }
references:
  - path: docs/codes.md
    description: "valid error codes catalogue"
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'yg-node.yaml'), `name: svc
type: service
description: svc node
mapping:
  - src/svc.ts
aspects:
  - a
`, 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'log.md'), '', 'utf-8');

    const out = execFileSync('node', [CLI, 'context', '--file', 'src/svc.ts'], {
      cwd: repo,
      encoding: 'utf-8',
    });

    // Must list the content.md read path
    expect(out).toContain('read: .yggdrasil/aspects/a/content.md');
    // Must list the reference with its description
    expect(out).toContain('read: docs/codes.md — valid error codes catalogue');
  });
});
