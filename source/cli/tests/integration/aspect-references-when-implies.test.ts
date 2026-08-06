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

describe('integration — aspect references with implies', () => {
  const repos: string[] = [];
  afterEach(() => {
    while (repos.length > 0) rmSync(repos.pop()!, { recursive: true, force: true });
  });

  it('each aspect block shows only its own references, not the implied aspect references', () => {
    const repo = mkdtempSync(join(tmpdir(), 'yg-refs-impl-'));
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    mkdirSync(join(ygg, 'aspects', 'a'), { recursive: true });
    mkdirSync(join(ygg, 'aspects', 'b'), { recursive: true });
    mkdirSync(join(ygg, 'model', 'svc'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'docs'), { recursive: true });

    writeFileSync(join(repo, 'src', 'svc.ts'), 'export const x = 1;\n', 'utf-8');
    writeFileSync(join(repo, 'docs', 'refA.md'), 'REFERENCE_A\n', 'utf-8');
    writeFileSync(join(repo, 'docs', 'refB.md'), 'REFERENCE_B\n', 'utf-8');
    writeFileSync(join(ygg, 'yg-config.yaml'), YG_CONFIG, 'utf-8');
    writeFileSync(join(ygg, 'yg-architecture.yaml'), YG_ARCH, 'utf-8');

    // Aspect A implies B and has its own reference
    writeFileSync(join(ygg, 'aspects', 'a', 'yg-aspect.yaml'), `name: A
description: aspect A
reviewer: { type: llm }
implies: [b]
references:
  - docs/refA.md
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');

    // Aspect B has its own reference
    writeFileSync(join(ygg, 'aspects', 'b', 'yg-aspect.yaml'), `name: B
description: aspect B
reviewer: { type: llm }
references:
  - docs/refB.md
`, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'b', 'content.md'), '# B\n', 'utf-8');

    // Node svc has aspect A (which brings B via implies)
    writeFileSync(join(ygg, 'model', 'svc', 'yg-node.yaml'), `name: svc
type: service
description: svc node
mapping:
  - src/svc.ts
aspects:
  - a
`, 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'log.md'), '', 'utf-8');

    const out = execFileSync('node', [CLI, 'context', '--node', 'svc'], {
      cwd: repo,
      encoding: 'utf-8',
    });

    // Find the index positions of aspect A and B headers
    const idxA = out.indexOf('a [enforced] — aspect A');
    const idxB = out.indexOf('b [enforced] — aspect B');
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);

    // Both are present, A comes before B in the output (A is direct, B is implied)
    expect(idxA).toBeLessThan(idxB);

    // refA.md appears between A's header and B's header (under A's block)
    const idxRefA = out.indexOf('docs/refA.md');
    expect(idxRefA).toBeGreaterThan(idxA);
    expect(idxRefA).toBeLessThan(idxB);

    // refB.md appears after B's header (under B's block)
    const idxRefB = out.indexOf('docs/refB.md');
    expect(idxRefB).toBeGreaterThan(idxB);

    // A's references do NOT appear under B's block
    // (refA.md does not appear after B's index)
    const idxRefAAfterB = out.indexOf('docs/refA.md', idxB);
    expect(idxRefAAfterB).toBe(-1);

    // B's references do NOT appear before B's header
    const idxRefBBeforeB = out.lastIndexOf('docs/refB.md', idxB - 1);
    expect(idxRefBBeforeB).toBe(-1);
  });
});
